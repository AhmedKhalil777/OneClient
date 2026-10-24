import { dirname, join } from "node:path";
import { ConfigStore } from "./config/config-store.js";
import { PluginMetadataStore } from "./db/plugin-metadata-store.js";
import { ConnectionManager } from "./connections/connection-manager.js";
import { type FileDialogs, registerIpcHandlers } from "./rpc/handlers.js";
import { SearchService } from "./search/search-service.js";
import { OutputService } from "./output/output-service.js";
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
};

function log(pluginId: string, level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown): void {
  const prefix = `[plugin:${pluginId}]`;
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](prefix, message, meta ?? "");
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
  supervisor.setApi(async (_pluginId, method, args) => {
    switch (method) {
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

  registerIpcHandlers({
    rpc,
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
