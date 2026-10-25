import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { HostApiMethod, HostInboundMessage, HostOutboundMessage, InvokeKind } from "../shared/host-protocol.js";
import type { FileSecretStore } from "../secrets/secret-store.js";
import type { OutputService } from "../output/output-service.js";
import type { TaskHandle, TaskService } from "../tasks/task-service.js";
import type { PluginRecord } from "./plugin-manager.js";
import type { HostProcess, Platform } from "../platform/platform.js";

type LogFn = (pluginId: string, level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) => void;
type RegisteredFn = (pluginId: string, contribution: HostOutboundMessage & { type: "registered" }) => void;
type ExitFn = (pluginId: string, code: number) => void;
type ViewPushFn = (pluginId: string, viewId: string, connectionId: string | undefined, message: unknown) => void;

/** What core's workspace offers plugins (context.workspace) — wired in by main/index.ts. */
export interface WorkspaceBridge {
  folders(): Array<{ name: string; path: string }>;
  openFile(path: string, options?: { line?: number; column?: number; length?: number }): Promise<void>;
}

/** Answers the host APIs that need core state (context.connections, context.contributions) — wired in by main/index.ts. */
export type HostApiBridge = (pluginId: string, method: HostApiMethod, args: unknown[]) => Promise<unknown>;

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface HostHandle {
  pluginId: string;
  process: HostProcess;
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
  private readonly hostEntryPath = join(__dirname, "../extension-host/bootstrap.js");
  private workspace: WorkspaceBridge | undefined;
  private taskService: TaskService | undefined;
  private readonly explorerRefreshListeners = new Set<(connectionId: string) => void>();
  /** Plugin tasks by the host's task id. */
  private readonly pluginTasks = new Map<string, TaskHandle>();

  constructor(
    private readonly secrets: FileSecretStore,
    private readonly onRegistered: RegisteredFn,
    private readonly onExit: ExitFn,
    private readonly log: LogFn,
    private readonly onViewPush: ViewPushFn,
    private readonly output: OutputService,
    private readonly fork: Platform["fork"],
  ) {}

  private pluginName: (pluginId: string) => string = (id) => id;

  /** Plugins' context.tasks report to this service (labelled with the plugin's display name). */
  setTasks(service: TaskService, pluginName: (pluginId: string) => string): void {
    this.taskService = service;
    this.pluginName = pluginName;
  }

  /** A plugin asked for a connection's explorer to be re-fetched (`context.refreshExplorer`). */
  onExplorerRefresh(listener: (connectionId: string) => void): () => void {
    this.explorerRefreshListeners.add(listener);
    return () => this.explorerRefreshListeners.delete(listener);
  }

  setWorkspace(bridge: WorkspaceBridge): void {
    this.workspace = bridge;
  }

  private api: HostApiBridge | undefined;

  setApi(bridge: HostApiBridge): void {
    this.api = bridge;
  }

  /** Tells every running plugin that the workspace folders changed (context.workspace.onDidChangeFolders). */
  broadcastWorkspaceFolders(folders: Array<{ name: string; path: string }>): void {
    for (const handle of this.hosts.values()) this.send(handle, { type: "workspace:changed", folders });
  }

  isActive(pluginId: string): boolean {
    return this.hosts.has(pluginId);
  }

  async activate(record: PluginRecord): Promise<void> {
    if (this.hosts.has(record.id)) return;
    const main = record.manifest.main;
    if (!main) throw new Error(`Plugin "${record.id}" has no "main" entry — nothing to run in an extension host.`);

    const child = this.fork(this.hostEntryPath, `oneclient-plugin:${record.id}`);

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

    child.on("message", (msg) => this.handleMessage(handle, msg as HostOutboundMessage));

    const activatePromise = new Promise<void>((resolve, reject) => {
      handle.activation = { resolve, reject };
    });

    const mainPath = join(record.rootDir, main);
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
        this.output.append(handle.pluginId, "Log", msg.level, msg.message, msg.meta === undefined ? undefined : safeJson(msg.meta));
        break;
      case "output":
        this.output.append(handle.pluginId, msg.channel, msg.level, msg.message, msg.detail, msg.time);
        break;
      case "output:clear":
        this.output.clear(`${handle.pluginId}/${msg.channel}`);
        break;
      case "output:show":
        this.output.reveal(handle.pluginId, msg.channel);
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
      case "explorer:refresh":
        for (const listener of this.explorerRefreshListeners) listener(msg.connectionId);
        break;
      case "task:start": {
        if (!this.taskService) break;
        const task = this.taskService.start({
          title: msg.title,
          source: this.pluginName(handle.pluginId),
          cancellable: msg.cancellable,
          onCancel: () => this.send(handle, { type: "task:cancel", taskId: msg.taskId }),
        });
        this.pluginTasks.set(msg.taskId, task);
        break;
      }
      case "task:update": {
        const t = this.pluginTasks.get(msg.taskId);
        if (!t) break;
        if (msg.log) t.log(msg.log);
        if (msg.detail !== undefined || msg.progress !== undefined) t.report({ ...(msg.detail !== undefined ? { detail: msg.detail } : {}), ...(msg.progress !== undefined ? { progress: msg.progress } : {}) });
        break;
      }
      case "task:end": {
        const t = this.pluginTasks.get(msg.taskId);
        this.pluginTasks.delete(msg.taskId);
        if (!t) break;
        if (msg.ok) t.succeed();
        else t.fail(msg.error ?? "Failed.");
        break;
      }
      case "workspace:folders":
        this.send(handle, { type: "workspace:result", requestId: msg.requestId, ok: true, value: this.workspace?.folders() ?? [] });
        break;
      case "workspace:openFile": {
        const run = this.workspace ? this.workspace.openFile(msg.path, msg.options) : Promise.reject(new Error("The workspace isn't available."));
        run
          .then(() => this.send(handle, { type: "workspace:result", requestId: msg.requestId, ok: true }))
          .catch((err: unknown) => this.send(handle, { type: "workspace:result", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) }));
        break;
      }
      case "api:request": {
        const run = this.api ? this.api(handle.pluginId, msg.method, msg.args) : Promise.reject(new Error("Host APIs aren't available."));
        run
          .then((value) => this.send(handle, { type: "api:result", requestId: msg.requestId, ok: true, value }))
          .catch((err: unknown) => this.send(handle, { type: "api:result", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) }));
        break;
      }
    }
  }

  private send(handle: HostHandle, message: HostInboundMessage): void {
    handle.process.postMessage(message);
  }
}

function safeJson(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
