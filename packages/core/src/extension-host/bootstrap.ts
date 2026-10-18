import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type {
  CommandContext,
  CommandHandler,
  ConnectionContext,
  ConnectionHandle,
  ConnectionProvider,
  Disposable,
  ExplorerContext,
  ExplorerProvider,
  Logger,
  OutputChannel,
  OutputLevel,
  PluginContext,
  PluginModule,
  SecretStore,
  ViewMessageHandler,
  Workspace,
  WorkspaceFolder,
} from "@oneclient/plugin-api";
import type { HostInboundMessage, HostOutboundMessage } from "../shared/host-protocol.js";

/**
 * Entry module loaded into each plugin's dedicated `utilityProcess` (see
 * ExtensionHostSupervisor). This is the *only* place `@oneclient/plugin-api`
 * interfaces are actually implemented on the host side — everything here
 * is internal plumbing a plugin author never sees; they only ever
 * implement the plugin-api interfaces themselves.
 */

let pluginId = "";
let deactivateFn: (() => void | Promise<void>) | undefined;

const connectionProviders = new Map<string, ConnectionProvider>();
const explorerProvidersByNodeType = new Map<string, ExplorerProvider>();
const commandHandlers = new Map<string, CommandHandler>();
const viewHandlers = new Map<string, ViewMessageHandler>();
const connectionHandles = new Map<string, ConnectionHandle>();

const secretGetWaiters = new Map<string, (value: string | undefined) => void>();
const secretAckWaiters = new Map<string, () => void>();
const workspaceWaiters = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
const folderListeners = new Set<(folders: WorkspaceFolder[]) => void>();

function post(message: HostOutboundMessage): void {
  process.parentPort.postMessage(message);
}

function makeLogger(): Logger {
  const emit = (level: "debug" | "info" | "warn" | "error") => (message: string, meta?: Record<string, unknown>) =>
    post({ type: "log", level, message, meta });
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

const outputChannels = new Map<string, OutputChannel>();

function makeOutputChannel(name: string): OutputChannel {
  const existing = outputChannels.get(name);
  if (existing) return existing;
  const log = (level: OutputLevel, message: string, detail?: string) =>
    post({ type: "output", channel: name, level, message, time: Date.now(), ...(detail ? { detail } : {}) });
  const channel: OutputChannel = {
    name,
    log,
    debug: (m, d) => log("debug", m, d),
    info: (m, d) => log("info", m, d),
    warn: (m, d) => log("warn", m, d),
    error: (m, d) => log("error", m, d),
    appendLine: (m) => log("info", m),
    clear: () => post({ type: "output:clear", channel: name }),
    show: () => post({ type: "output:show", channel: name }),
  };
  outputChannels.set(name, channel);
  return channel;
}

function makeSecrets(): SecretStore {
  return {
    get(key) {
      const requestId = randomUUID();
      const promise = new Promise<string | undefined>((resolve) => secretGetWaiters.set(requestId, resolve));
      post({ type: "secret:get", requestId, key });
      return promise;
    },
    set(key, value) {
      const requestId = randomUUID();
      const promise = new Promise<void>((resolve) => secretAckWaiters.set(requestId, resolve));
      post({ type: "secret:set", requestId, key, value });
      return promise;
    },
    delete(key) {
      const requestId = randomUUID();
      const promise = new Promise<void>((resolve) => secretAckWaiters.set(requestId, resolve));
      post({ type: "secret:delete", requestId, key });
      return promise;
    },
  };
}

function workspaceRequest<T>(message: { type: "workspace:folders" } | { type: "workspace:openFile"; path: string; options?: { line?: number; column?: number; length?: number } }): Promise<T> {
  const requestId = randomUUID();
  const promise = new Promise<T>((resolve, reject) => workspaceWaiters.set(requestId, { resolve: resolve as (v: unknown) => void, reject }));
  post({ ...message, requestId });
  return promise;
}

function makeWorkspace(): Workspace {
  return {
    getFolders: () => workspaceRequest<WorkspaceFolder[]>({ type: "workspace:folders" }),
    onDidChangeFolders(listener) {
      folderListeners.add(listener);
      return { dispose: () => folderListeners.delete(listener) };
    },
    openFile: (path, options) => workspaceRequest<void>({ type: "workspace:openFile", path, ...(options ? { options } : {}) }),
  };
}

function makeContext(extensionPath: string): PluginContext {
  const subscriptions: Disposable[] = [];
  return {
    pluginId,
    extensionPath,
    logger: makeLogger(),
    secrets: makeSecrets(),
    createOutputChannel: makeOutputChannel,
    workspace: makeWorkspace(),
    subscriptions,
    registerConnectionProvider(provider) {
      connectionProviders.set(provider.typeId, provider);
      post({
        type: "registered",
        contribution: { kind: "connection", typeId: provider.typeId, configSchema: provider.configSchema, uiSchema: provider.uiSchema },
      });
      return { dispose: () => connectionProviders.delete(provider.typeId) };
    },
    registerExplorerProvider(provider) {
      for (const nodeType of provider.nodeTypes) explorerProvidersByNodeType.set(nodeType, provider);
      post({ type: "registered", contribution: { kind: "explorer", nodeTypes: provider.nodeTypes } });
      return { dispose: () => provider.nodeTypes.forEach((nt) => explorerProvidersByNodeType.delete(nt)) };
    },
    registerCommand(handler) {
      commandHandlers.set(handler.commandId, handler);
      post({ type: "registered", contribution: { kind: "command", commandId: handler.commandId } });
      return { dispose: () => commandHandlers.delete(handler.commandId) };
    },
    registerView(viewId, handler) {
      viewHandlers.set(viewId, handler);
      post({ type: "registered", contribution: { kind: "view", viewId } });
      return { dispose: () => viewHandlers.delete(viewId) };
    },
  };
}

process.parentPort.on("message", (e) => {
  void handleMessage(e.data as HostInboundMessage);
});

async function handleMessage(msg: HostInboundMessage): Promise<void> {
  switch (msg.type) {
    case "activate": {
      pluginId = msg.pluginId;
      try {
        const mod = (await import(pathToFileURL(msg.mainPath).href)) as PluginModule;
        deactivateFn = mod.deactivate;
        await mod.activate(makeContext(msg.extensionPath));
        post({ type: "activated" });
      } catch (err) {
        post({ type: "activate:error", error: describeError(err) });
      }
      return;
    }
    case "invoke": {
      try {
        const result = await dispatchInvoke(msg);
        post({ type: "invoke:result", requestId: msg.requestId, ok: true, result });
      } catch (err) {
        post({ type: "invoke:result", requestId: msg.requestId, ok: false, error: describeError(err) });
      }
      return;
    }
    case "deactivate": {
      try {
        await deactivateFn?.();
      } catch {
        // best-effort — the host process is about to be killed regardless
      }
      post({ type: "deactivated" });
      return;
    }
    case "secret:result": {
      secretGetWaiters.get(msg.requestId)?.(msg.value);
      secretGetWaiters.delete(msg.requestId);
      return;
    }
    case "workspace:result": {
      const waiter = workspaceWaiters.get(msg.requestId);
      workspaceWaiters.delete(msg.requestId);
      if (msg.ok) waiter?.resolve(msg.value);
      else waiter?.reject(new Error(msg.error));
      return;
    }
    case "workspace:changed": {
      for (const listener of folderListeners) {
        try {
          listener(msg.folders);
        } catch {
          // a plugin's listener failing must not break the others
        }
      }
      return;
    }
    case "secret:ack": {
      secretAckWaiters.get(msg.requestId)?.();
      secretAckWaiters.delete(msg.requestId);
      return;
    }
    case "view:message": {
      const handler = viewHandlers.get(msg.viewId);
      if (!handler) return;
      const reply = (replyMessage: unknown) =>
        post({ type: "view:push", viewId: msg.viewId, connectionId: msg.connectionId, message: replyMessage });
      try {
        await handler.onMessage(msg.message, { connectionId: msg.connectionId, reply });
      } catch (err) {
        reply({ error: describeError(err) });
      }
      return;
    }
    case "view:dispose": {
      await viewHandlers.get(msg.viewId)?.onDispose?.(msg.connectionId);
      return;
    }
  }
}

type InvokeMessage = Extract<HostInboundMessage, { type: "invoke" }>;

async function dispatchInvoke(msg: InvokeMessage): Promise<unknown> {
  const controller = new AbortController();
  const logger = makeLogger();
  const secrets = makeSecrets();

  switch (msg.kind) {
    case "connection": {
      const provider = connectionProviders.get(msg.target);
      if (!provider) throw new Error(`No connection provider registered for type "${msg.target}".`);
      const ctx: ConnectionContext = { logger, secrets, signal: controller.signal, connectionId: msg.connectionId };

      if (msg.method === "test") {
        return provider.test(msg.args[0] as Record<string, unknown>, ctx);
      }
      if (msg.method === "connect") {
        const handle = await provider.connect(msg.args[0] as Record<string, unknown>, ctx);
        if (msg.connectionId) connectionHandles.set(msg.connectionId, handle);
        return { id: handle.id, typeId: handle.typeId };
      }
      if (msg.method === "disconnect") {
        if (!msg.connectionId) throw new Error("disconnect requires a connectionId.");
        const handle = connectionHandles.get(msg.connectionId);
        if (!handle) return undefined; // already disconnected / never connected this session
        connectionHandles.delete(msg.connectionId);
        return provider.disconnect(handle, ctx);
      }
      throw new Error(`Unknown connection method "${msg.method}".`);
    }

    case "explorer": {
      const provider = explorerProvidersByNodeType.get(msg.target);
      if (!provider) throw new Error(`No explorer provider registered for node type "${msg.target}".`);
      if (!msg.connectionId) throw new Error("explorer getChildren requires a connectionId.");
      const ctx: ExplorerContext = { logger, secrets, signal: controller.signal, connectionId: msg.connectionId };
      return provider.getChildren((msg.args[0] as never) ?? null, ctx);
    }

    case "command": {
      const handler = commandHandlers.get(msg.target);
      if (!handler) throw new Error(`No command handler registered for "${msg.target}".`);
      const ctx: CommandContext = { logger, secrets, signal: controller.signal };
      return handler.execute(msg.args, ctx);
    }
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
