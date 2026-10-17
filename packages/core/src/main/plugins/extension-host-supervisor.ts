import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { HostInboundMessage, HostOutboundMessage, InvokeKind } from "../../shared/host-protocol.js";
import type { SqliteSecretStore } from "../secrets/secret-store.js";
import type { PluginRecord } from "./plugin-manager.js";

type LogFn = (pluginId: string, level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) => void;
type RegisteredFn = (pluginId: string, contribution: HostOutboundMessage & { type: "registered" }) => void;
type ExitFn = (pluginId: string, code: number) => void;
type ViewPushFn = (pluginId: string, viewId: string, connectionId: string | undefined, message: unknown) => void;

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface HostHandle {
  pluginId: string;
  process: UtilityProcess;
  pending: Map<string, PendingInvoke>;
  activation?: { resolve: () => void; reject: (err: Error) => void };
  deactivation?: { resolve: () => void };
}

/**
 * Owns one `utilityProcess` per active plugin. This is the crash-isolation
 * boundary described in ARCHITECTURE.md: a plugin's process exiting (crash
 * or otherwise) only ever rejects *that plugin's* in-flight requests and
 * fires `onExit` — it never throws into the caller or touches any other
 * plugin's host.
 */
export class ExtensionHostSupervisor {
  private readonly hosts = new Map<string, HostHandle>();
  private readonly hostEntryPath = join(__dirname, "extension-host.js");

  constructor(
    private readonly secrets: SqliteSecretStore,
    private readonly onRegistered: RegisteredFn,
    private readonly onExit: ExitFn,
    private readonly log: LogFn,
    private readonly onViewPush: ViewPushFn,
  ) {}

  isActive(pluginId: string): boolean {
    return this.hosts.has(pluginId);
  }

  async activate(record: PluginRecord): Promise<void> {
    if (this.hosts.has(record.id)) return;

    const child = utilityProcess.fork(this.hostEntryPath, [], {
      serviceName: `oneclient-plugin:${record.id}`,
      stdio: "pipe",
    });

    const handle: HostHandle = { pluginId: record.id, process: child, pending: new Map() };
    this.hosts.set(record.id, handle);

    child.stdout?.on("data", (d: Buffer) => this.log(record.id, "debug", d.toString().trimEnd()));
    child.stderr?.on("data", (d: Buffer) => this.log(record.id, "error", d.toString().trimEnd()));

    child.on("exit", (code: number) => {
      this.hosts.delete(record.id);
      for (const { reject } of handle.pending.values()) {
        reject(new Error(`Plugin "${record.id}" process exited (code ${code}) before responding.`));
      }
      handle.pending.clear();
      if (handle.activation) handle.activation.reject(new Error(`Process exited (code ${code}) during activation.`));
      this.onExit(record.id, code);
    });

    child.on("message", (msg: HostOutboundMessage) => this.handleMessage(handle, msg));

    const activatePromise = new Promise<void>((resolve, reject) => {
      handle.activation = { resolve, reject };
    });

    const mainPath = join(record.rootDir, record.manifest.main);
    this.send(handle, { type: "activate", pluginId: record.id, extensionPath: record.rootDir, mainPath });

    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`Plugin "${record.id}" activation timed out.`)), 15_000),
    );
    try {
      await Promise.race([activatePromise, timeout]);
    } finally {
      handle.activation = undefined;
    }
  }

  async deactivate(pluginId: string): Promise<void> {
    const handle = this.hosts.get(pluginId);
    if (!handle) return;
    const deactivatePromise = new Promise<void>((resolve) => {
      handle.deactivation = { resolve };
    });
    this.send(handle, { type: "deactivate" });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([deactivatePromise, timeout]);
    handle.process.kill();
    this.hosts.delete(pluginId);
  }

  invoke(
    pluginId: string,
    kind: InvokeKind,
    target: string,
    method: string,
    args: unknown[],
    connectionId?: string,
  ): Promise<unknown> {
    const handle = this.hosts.get(pluginId);
    if (!handle) return Promise.reject(new Error(`Plugin "${pluginId}" is not active.`));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      handle.pending.set(requestId, { resolve, reject });
      this.send(handle, { type: "invoke", requestId, kind, target, method, args, connectionId });
    });
  }

  /** Fire-and-forget: a view's reply (if any) arrives later as a "view:push" the caller already subscribed to via onViewPush. */
  sendViewMessage(pluginId: string, viewId: string, connectionId: string | undefined, message: unknown): void {
    const handle = this.hosts.get(pluginId);
    if (!handle) return;
    this.send(handle, { type: "view:message", viewId, connectionId, message });
  }

  sendViewDispose(pluginId: string, viewId: string, connectionId: string | undefined): void {
    const handle = this.hosts.get(pluginId);
    if (!handle) return;
    this.send(handle, { type: "view:dispose", viewId, connectionId });
  }

  private handleMessage(handle: HostHandle, msg: HostOutboundMessage): void {
    switch (msg.type) {
      case "activated":
        handle.activation?.resolve();
        break;
      case "activate:error":
        handle.activation?.reject(new Error(msg.error));
        break;
      case "registered":
        this.onRegistered(handle.pluginId, msg);
        break;
      case "invoke:result": {
        const pending = handle.pending.get(msg.requestId);
        if (!pending) return;
        handle.pending.delete(msg.requestId);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error));
        break;
      }
      case "log":
        this.log(handle.pluginId, msg.level, msg.message, msg.meta);
        break;
      case "secret:get":
        this.secrets
          .get(`${handle.pluginId}:${msg.key}`)
          .then((value) => this.send(handle, { type: "secret:result", requestId: msg.requestId, value }))
          .catch(() => this.send(handle, { type: "secret:result", requestId: msg.requestId }));
        break;
      case "secret:set":
        this.secrets
          .set(`${handle.pluginId}:${msg.key}`, msg.value)
          .then(() => this.send(handle, { type: "secret:ack", requestId: msg.requestId }));
        break;
      case "secret:delete":
        this.secrets
          .delete(`${handle.pluginId}:${msg.key}`)
          .then(() => this.send(handle, { type: "secret:ack", requestId: msg.requestId }));
        break;
      case "deactivated":
        handle.deactivation?.resolve();
        break;
      case "view:push":
        this.onViewPush(handle.pluginId, msg.viewId, msg.connectionId, msg.message);
        break;
    }
  }

  private send(handle: HostHandle, message: HostInboundMessage): void {
    handle.process.postMessage(message);
  }
}
