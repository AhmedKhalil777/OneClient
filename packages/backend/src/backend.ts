import { dirname, join } from "node:path";
import { ConfigStore } from "./config/config-store.js";
import { PluginMetadataStore } from "./db/plugin-metadata-store.js";
import { ConnectionManager } from "./connections/connection-manager.js";
import { type FileDialogs, registerIpcHandlers } from "./rpc/handlers.js";
import { SearchService } from "./search/search-service.js";
import { OutputService } from "./output/output-service.js";
import { NotificationService } from "./notifications/notification-service.js";
import { notificationForTask } from "./shared/notifications.js";
import type { TaskInfo } from "./tasks/task-service.js";
import { ExtensionHostSupervisor } from "./plugins/extension-host-supervisor.js";
import { PluginManager, type PluginRecord } from "./plugins/plugin-manager.js";
import { ProviderDirectory } from "./plugins/provider-directory.js";
import { ContributionRegistry } from "./plugins/registry.js";
import { FileSecretStore } from "./secrets/secret-store.js";
import { ThemeService } from "./themes/theme-service.js";
import { WorkspaceService } from "./workspace/workspace-service.js";
import { SearchWorker } from "./workspace/search-client.js";
import { EDITOR_VIEW } from "./workspace/files.js";
import { TERMINAL_VIEW, TerminalService } from "./terminal/terminal-service.js";
import { TaskService } from "./tasks/task-service.js";
import { TaskRunner } from "./tasks/task-runner.js";
import { GitService } from "./git/git-service.js";
import { CORE_PLUGIN_ID } from "./shared/core.js";
import { IpcChannel } from "./shared/ipc-contract.js";
import type { Platform } from "./platform/platform.js";
import type { RpcHost } from "./rpc/rpc-host.js";
import type { MessageFromViewFn, ViewHost } from "./views/view-host.js";

/** Core's own views: built with the renderer, hosted like plugin views. Page paths are relative to the renderer build. */
const CORE_VIEWS: Record<string, string> = {
  [EDITOR_VIEW]: "views/editor/index.html",
  [TERMINAL_VIEW]: "views/terminal/index.html",
  "git.diff": "views/diff/index.html",
  "git.graph": "views/graph/index.html",
};

function log(pluginId: string, level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown): void {
  const prefix = `[plugin:${pluginId}]`;
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](prefix, message, meta ?? "");
}

let runtimeLoggingInstalled = false;

/** Uncaught exceptions and unhandled rejections in the backend process land in the Application log (and still on stderr). */
function installRuntimeErrorLogging(appLog: (level: "info" | "warn" | "error", message: string, err?: unknown) => void): void {
  if (runtimeLoggingInstalled) return;
  runtimeLoggingInstalled = true;
  process.on("unhandledRejection", (reason) => {
    appLog("error", `Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`, reason);
    console.error("[oneclient] unhandled rejection", reason);
  });
  process.on("uncaughtException", (err) => {
    appLog("error", `Uncaught exception: ${err.message}`, err);
    console.error("[oneclient] uncaught exception", err);
  });
}

export interface BackendOptions {
  platform: Platform;
  rpc: RpcHost;
  /** Builds the runtime's view host; `onMessageFromView` delivers what views post. */
  createViews: (onMessageFromView: MessageFromViewFn) => ViewHost;
  /** Built-in product icons; defaults to this package's resources/icons. */
  builtinIconDir?: string;
  dialogs?: FileDialogs;
  /** Runs as soon as plugins and themes exist, before the plugin scan — e.g. to start serving assets. */
  onAssetsReady?: (pluginManager: PluginManager, themes: ThemeService) => void;
}

export type Backend = Awaited<ReturnType<typeof createBackend>>;

/**
 * The whole oneClient backend — plugins and their extension hosts, connections, the workspace (Explorer, editor,
 * search), terminal, tasks, git, themes — wired to a runtime: the desktop app (main/index.ts) or the web server
 * (server/main.ts). Only `platform`, `rpc` and the view host differ between them.
 *
 * Throws ConfigVersionError when the config was written by a newer oneClient (the caller tells the user and stops).
 */
export async function createBackend(opts: BackendOptions) {
  const { platform, rpc } = opts;

  // All app metadata lives in ~/.oneclient/oneclient.json (see config-store.ts); secrets next to it.
  const config = new ConfigStore(undefined, (message) => console.warn("[config]", message));
  const secrets = new FileSecretStore(join(dirname(config.filePath), platform.secretsFile), platform.cipher);
  const metadata = new PluginMetadataStore(config);
  const registry = new ContributionRegistry();
  const providers = new ProviderDirectory();
  const pluginManager = new PluginManager(platform.pluginDirs, registry, metadata);
  const themes = new ThemeService({
    getRegistry: () => registry.snapshot(),
    getPluginRoot: (pluginId) => pluginManager.getRecord(pluginId)?.rootDir,
    builtinIconDir: opts.builtinIconDir ?? join(__dirname, "../resources/icons"),
    settings: { load: () => config.getSettings(), save: (next) => config.setSettings(next) },
    log: (message) => console.warn("[themes]", message),
  });
  opts.onAssetsReady?.(pluginManager, themes);

  // The supervisor and the view host each call into the other (a host pushes a view message → the view host delivers
  // it; a view posts a message → the supervisor forwards it). Both closures only fire after everything is built.
  let supervisor!: ExtensionHostSupervisor;
  let workspace!: WorkspaceService;
  let terminal!: TerminalService;
  const output = new OutputService();
  const notifications = new NotificationService();
  // Output → "oneClient — Application": what goes wrong in the app itself, with the stack as expandable detail.
  const appLog = (level: "info" | "warn" | "error", message: string, err?: unknown) =>
    output.append(CORE_PLUGIN_ID, "Application", level, message, err instanceof Error ? err.stack : err === undefined ? undefined : String(err));
  installRuntimeErrorLogging(appLog);
  appLog("info", "oneClient backend started.");
  const views = opts.createViews((pluginId, viewId, connectionId, message) => {
    if (pluginId !== CORE_PLUGIN_ID) return supervisor.sendViewMessage(pluginId, viewId, connectionId, message);
    if (viewId === EDITOR_VIEW) workspace.onEditorMessage(connectionId, message);
    else if (viewId === TERMINAL_VIEW) terminal.fromView(message);
  });

  supervisor = new ExtensionHostSupervisor(
    secrets,
    (pluginId, msg) => {
      const c = msg.contribution;
      if (c.kind === "connection") providers.registerConnection({ pluginId, typeId: c.typeId, configSchema: c.configSchema as never, uiSchema: c.uiSchema as never });
      else if (c.kind === "explorer") providers.registerExplorer(pluginId, c.nodeTypes);
      else if (c.kind === "command") providers.registerCommand(pluginId, c.commandId);
    },
    (pluginId, code) => {
      providers.removeForPlugin(pluginId);
      appLog("error", `Plugin "${pluginId}" stopped unexpectedly (code ${code}). Its Output → Log channel has the details.`);
      pluginManager.setState(pluginId, "crashed", `Extension host exited unexpectedly (code ${code}).`);
    },
    log,
    (_pluginId, viewId, connectionId, message) => views.push(viewId, connectionId, message),
    output,
    platform.fork,
  );

  async function tryActivate(record: PluginRecord): Promise<void> {
    // Declarative plugins (themes, icons) have no code to run: their contributions are
    // already live from the manifest, so there's no extension-host process to start.
    if (!record.manifest.main) {
      pluginManager.setState(record.id, "active");
      return;
    }
    pluginManager.setState(record.id, "activating");
    try {
      await supervisor.activate(record);
      pluginManager.setState(record.id, "active");
    } catch (err) {
      appLog("error", `Plugin "${record.id}" failed to start: ${err instanceof Error ? err.message : String(err)}`, err);
      pluginManager.setState(record.id, "crashed", err instanceof Error ? err.message : String(err));
    }
  }

  async function ensureActivated(pluginId: string): Promise<void> {
    if (supervisor.isActive(pluginId)) return;
    const record = pluginManager.getRecord(pluginId);
    if (!record) throw new Error(`Unknown plugin "${pluginId}".`);
    if (record.state === "disabled") throw new Error(`Plugin "${pluginId}" is disabled.`);
    await tryActivate(record);
  }

  // Every enabled plugin is activated as soon as it loads, so its explorer is
  // live in the activity bar right away. Activation never opens a connection —
  // a plugin starts with zero connections until the user creates one.
  pluginManager.on("loaded", (record: PluginRecord) => {
    void tryActivate(record);
  });

  const connections = new ConnectionManager(
    config,
    registry,
    providers,
    secrets,
    ensureActivated,
    (pluginId, kind, target, method, args, connectionId) => supervisor.invoke(pluginId, kind, target, method, args, connectionId),
    (pluginId) => pluginManager.getRecord(pluginId)?.manifest?.version,
  );

  // The workspace (core): the folders open in the Explorer — its tree, file commands, the editor's backend and
  // text search on a worker thread. Shared with every plugin through context.workspace.
  const searchWorker = new SearchWorker();
  workspace = new WorkspaceService(config, searchWorker, (viewId, folderId, message) => views.push(viewId, folderId, message));
  // The integrated terminal (core): shells in their own process; new terminals start in the first open folder.
  terminal = new TerminalService((message) => views.push(TERMINAL_VIEW, undefined, message), () => workspace.folders()[0]?.path, platform.fork);
  // Background tasks (Git network operations, the Task Runner, plugins' context.tasks) and source control.
  const tasks = new TaskService();
  supervisor.setTasks(tasks, (pluginId) => pluginManager.getRecord(pluginId)?.manifest?.displayName ?? pluginId);
  // A task that fails, or finishes after a few seconds, tells the user — they have likely looked away by then.
  const lastTaskStates = new Map<string, TaskInfo>();
  tasks.onChanged((list) => {
    for (const t of list) {
      const note = notificationForTask(lastTaskStates.get(t.id), t);
      lastTaskStates.set(t.id, t);
      if (note) notifications.show(note);
    }
  });
  const taskRunner = new TaskRunner(tasks, () => workspace.folders());
  const gitService = new GitService(tasks);
  void gitService.setFolders(workspace.folders());
  workspace.onChanged((folders) => void gitService.setFolders(folders));

  /** Commands implemented by core itself (files.*, terminal.*, git.*): views, menus and context menus call them by id. */
  const fileCommands = workspace.commands();
  // Saving, creating, renaming or deleting a file changes what git sees.
  for (const id of ["files.writeFile", "files.newFile", "files.newFolder", "files.rename", "files.delete", "files.replace"]) {
    const run = fileCommands[id]!;
    fileCommands[id] = async (args) => {
      try {
        return await run(args);
      } finally {
        gitService.scheduleRefresh();
      }
    };
  }
  const coreCommands: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    ...fileCommands,
    ...terminal.commands(),
    // The Git Graph view: repositories, the commit log, a commit's files and message, and checkout.
    "git.repos": async () => gitService.list(),
    "git.log": async (a) => gitService.log(a.root, { all: a.all === true, limit: Math.min(5000, Math.max(1, Number(a.limit) || 500)) }),
    "git.commitFiles": async (a) => gitService.commitFiles(a.root, String(a.sha ?? "")),
    "git.commitDetails": async (a) => gitService.commitDetails(a.root, String(a.sha ?? "")),
    "git.fetchRepo": async (a) => gitService.fetch(a.root),
    "git.checkoutRef": async (a) => {
      await gitService.checkout(a.root, String(a.name ?? ""));
      return { ok: true };
    },
    // The diff view: both sides of a file.
    "git.diffContents": async (a) => {
      const path = String(a.path ?? "");
      const [left, right] = await Promise.all([
        gitService.fileVersion(a.root, String(a.origPath ?? path), String(a.left ?? "HEAD")),
        gitService.fileVersion(a.root, path, String(a.right ?? "worktree")),
      ]);
      return { left, right };
    },
  };

  async function openWorkspaceFile(path: string, options: { line?: number | undefined; column?: number | undefined; length?: number | undefined } = {}): Promise<void> {
    const location = workspace.locate(path);
    if (!location) throw new Error(`"${path}" isn't inside a folder open in the Explorer.`);
    rpc.broadcast(IpcChannel.WorkspaceOpenFile, { folderId: location.folder.id, relPath: location.relPath });
    // The editor tab picks this up when it has loaded (or right away if it's open already).
    if (options.line) workspace.reveal(location.folder.id, { path: location.relPath, line: options.line, col: options.column ?? 1, length: options.length ?? 0 });
  }
  supervisor.setWorkspace({ folders: () => workspace.folders().map(({ name, path }) => ({ name, path })), openFile: openWorkspaceFile });
  // context.connections / context.contributions: what plugins may read and do across plugins.
  supervisor.setApi(async (pluginId, method, args) => {
    switch (method) {
      case "notifications.show": {
        const [message, options] = args as [unknown, Record<string, unknown> | undefined];
        const o = options ?? {};
        const severity = ["info", "success", "warning", "error"].includes(String(o.severity)) ? (o.severity as "info" | "success" | "warning" | "error") : "info";
        const info = notifications.show({
          pluginId,
          source: pluginManager.getRecord(pluginId)?.manifest?.displayName ?? pluginId,
          severity,
          message: String(message ?? ""),
          detail: typeof o.detail === "string" ? o.detail : undefined,
          actions: Array.isArray(o.actions)
            ? (o.actions as Array<{ label?: unknown; commandId?: unknown; args?: unknown }>).map((a) => ({ label: String(a.label ?? ""), ...(typeof a.commandId === "string" ? { commandId: a.commandId } : {}), ...(Array.isArray(a.args) ? { args: a.args } : {}) }))
            : undefined,
          sticky: typeof o.sticky === "boolean" ? o.sticky : undefined,
          silent: o.silent === true,
          key: typeof o.key === "string" && o.key ? o.key.slice(0, 80) : undefined,
        });
        return { id: info.id };
      }
      case "notifications.dismiss": {
        const id = String(args[0] ?? "");
        // A plugin may only remove its own.
        if (notifications.list().some((n) => n.id === id && n.pluginId === pluginId)) notifications.dismiss(id);
        return undefined;
      }
      case "connections.list":
        return connections.listWithConfig();
      case "connections.create": {
        const { typeId, name, config: cfg } = (args[0] ?? {}) as { typeId?: unknown; name?: unknown; config?: unknown };
        if (typeof typeId !== "string" || typeof name !== "string" || !name.trim()) throw new Error("A connection needs a typeId and a name.");
        const created = await connections.create(typeId, name.trim(), cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : {});
        return { id: created.id };
      }
      case "connections.test": {
        const [typeId, cfg] = args as [unknown, unknown];
        if (typeof typeId !== "string") throw new Error("connections.test needs a typeId.");
        try {
          return await connections.test(typeId, cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : {});
        } catch (err) {
          return { success: false, message: err instanceof Error ? err.message : String(err) };
        }
      }
      case "contributions.get":
        return typeof args[0] === "string" ? registry.getExtensions(args[0]) : [];
      case "aiTools.call": {
        // Only commands a plugin has listed as an AI tool can be reached this way — not any command of any plugin.
        const [commandId, input] = args as [unknown, unknown];
        if (typeof commandId !== "string") throw new Error("aiTools.call needs a command id.");
        const tool = registry.getExtensions("oneclient.aiTools").find((t) => t.command === commandId);
        if (!tool) throw new Error(`"${commandId}" is not listed as an AI tool by any plugin.`);
        await ensureActivated(tool.pluginId);
        const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
        if (typeof payload.connectionId === "string" && connections.list().some((c) => c.id === payload.connectionId)) await connections.ensureConnected(payload.connectionId);
        return supervisor.invoke(tool.pluginId, "command", commandId, "execute", [payload]);
      }
    }
  });
  views.setOpenFileHandler(openWorkspaceFile);
  workspace.onChanged((folders) => {
    supervisor.broadcastWorkspaceFolders(folders.map(({ name, path }) => ({ name, path })));
    rpc.broadcast(IpcChannel.WorkspaceChanged, folders);
  });

  const search = new SearchService(
    registry,
    connections,
    (pluginId, kind, target, method, args, connectionId) => supervisor.invoke(pluginId, kind, target, method, args, connectionId),
    [
      {
        // File names in every open folder (nested, fuzzy — "pm" finds plugin-manager.ts).
        id: "files",
        label: "Files",
        icon: "$(file)",
        order: 10,
        run: async (query, limit) =>
          (await workspace.quickOpen(query, limit)).map(({ folderId, folderName, ...hit }) => ({ ...hit, providerId: "core:files", pluginId: CORE_PLUGIN_ID, connectionId: folderId, connectionName: folderName })),
      },
    ],
  );

  // A request from the UI that throws is reported to the UI — and now also written to the Application log.
  const loggedRpc: RpcHost = {
    on: (channel, handler) => rpc.on(channel, handler),
    broadcast: (channel, payload) => rpc.broadcast(channel, payload),
    handle: (channel, handler) =>
      rpc.handle(channel, async (...args: unknown[]) => {
        try {
          return await (handler as (...a: unknown[]) => unknown)(...args);
        } catch (err) {
          appLog("error", `${channel} failed: ${err instanceof Error ? err.message : String(err)}`, err);
          throw err;
        }
      }),
  };

  registerIpcHandlers({
    rpc: loggedRpc,
    platform,
    themes,
    registry,
    pluginManager,
    connections,
    search,
    config,
    supervisor,
    views,
    output,
    notifications,
    ensureActivated,
    workspace,
    openWorkspaceFile,
    coreCommands,
    coreViewPage: (viewId) => CORE_VIEWS[viewId],
    terminal,
    tasks,
    taskRunner,
    gitService,
    ...(opts.dialogs ? { dialogs: opts.dialogs } : {}),
  });

  await pluginManager.scan();

  return {
    config,
    pluginManager,
    themes,
    views,
    workspace,
    gitService,
    connections,
    /** Stops every helper process (on quit / server shutdown). */
    async dispose(): Promise<void> {
      views.closeAll();
      terminal.dispose();
      taskRunner.stopAll();
      gitService.dispose();
      void searchWorker.dispose();
      await Promise.all(pluginManager.getRecords().filter((r) => r.state === "active").map((r) => supervisor.deactivate(r.id)));
    },
  };
}
