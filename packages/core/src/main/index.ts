import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, app, dialog } from "electron";
import { registerPluginAssetProtocolHandler, registerPluginAssetSchemeAsPrivileged } from "./assets/plugin-asset-protocol.js";

// Must run before any app.getPath("userData") call — otherwise Electron
// derives the userData folder name from package.json's "name" field
// ("@oneclient/core"), which makes an ugly on-disk path.
app.setName("oneClient");
// Must run before app.whenReady() — see plugin-asset-protocol.ts.
registerPluginAssetSchemeAsPrivileged();
import { ConfigStore, ConfigVersionError } from "./config/config-store.js";
import { PluginMetadataStore } from "./db/plugin-metadata-store.js";
import { ConnectionManager } from "./connections/connection-manager.js";
import { registerIpcHandlers } from "./ipc/handlers.js";
import { SearchService } from "./search/search-service.js";
import { OutputService } from "./output/output-service.js";
import { ExtensionHostSupervisor } from "./plugins/extension-host-supervisor.js";
import { PluginManager, type PluginRecord } from "./plugins/plugin-manager.js";
import { ProviderDirectory } from "./plugins/provider-directory.js";
import { ContributionRegistry } from "./plugins/registry.js";
import { FileSecretStore } from "./secrets/secret-store.js";
import { ThemeService } from "./themes/theme-service.js";
import { ViewHostManager } from "./views/view-host-manager.js";
import { createMainWindow } from "./windows.js";
import { WorkspaceService } from "./workspace/workspace-service.js";
import { SearchWorker } from "./workspace/search-client.js";
import { EDITOR_VIEW } from "./workspace/files.js";
import { TERMINAL_VIEW, TerminalService } from "./terminal/terminal-service.js";
import { CORE_PLUGIN_ID } from "../shared/core.js";
import { IpcChannel } from "../shared/ipc-contract.js";

function pluginDirs(): string[] {
  const dirs = [join(app.getPath("userData"), "plugins")];
  // Bundled plugins ship inside the app bundle's resources (the packaging step copies packages/plugins/* there);
  // in dev builds they load live from the repo, no install step needed.
  dirs.push(app.isPackaged ? join(process.resourcesPath, "plugins") : join(__dirname, "../../../plugins"));
  return dirs;
}

/** Core's own views (the file editor tab, the Terminal panel): built with the renderer, hosted like plugin views. */
const CORE_VIEWS: Record<string, string> = { [EDITOR_VIEW]: "views/editor/index.html", [TERMINAL_VIEW]: "views/terminal/index.html" };
function coreViewUrl(viewId: string): string | undefined {
  const page = CORE_VIEWS[viewId];
  if (!page) return undefined;
  const devServer = process.env["ELECTRON_RENDERER_URL"];
  return !app.isPackaged && devServer ? `${devServer}/${page}` : pathToFileURL(join(__dirname, "../renderer", page)).href;
}

function log(pluginId: string, level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown): void {
  const prefix = `[plugin:${pluginId}]`;
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](prefix, message, meta ?? "");
}

async function main(): Promise<void> {
  await app.whenReady();

  // All app metadata lives in ~/.oneclient/oneclient.json (see config-store.ts); secrets in ~/.oneclient/secrets.json.
  let config: ConfigStore;
  let secrets: FileSecretStore;
  try {
    config = new ConfigStore(undefined, (message) => console.warn("[config]", message));
    secrets = new FileSecretStore(config.secretsPath);
  } catch (err) {
    if (err instanceof ConfigVersionError) {
      // A newer oneClient wrote these files; opening them with this one could lose data, so stop here.
      dialog.showErrorBox("oneClient can't open its settings", err.message);
      app.quit();
      return;
    }
    throw err;
  }
  const metadata = new PluginMetadataStore(config);
  const registry = new ContributionRegistry();
  const providers = new ProviderDirectory();
  const pluginManager = new PluginManager(pluginDirs(), registry, metadata);
  const themes = new ThemeService({
    getRegistry: () => registry.snapshot(),
    getPluginRoot: (pluginId) => pluginManager.getRecord(pluginId)?.rootDir,
    // out/main → packages/core/resources/icons (built-in product icons)
    builtinIconDir: join(__dirname, "../../resources/icons"),
    settings: { load: () => config.getSettings(), save: (next) => config.setSettings(next) },
    log: (message) => console.warn("[themes]", message),
  });
  registerPluginAssetProtocolHandler(pluginManager, (id) => themes.resolveIconFile(id));

  const mainWindow = createMainWindow();

  // ExtensionHostSupervisor and ViewHostManager each need to call into the
  // other (a host pushes a view message -> ViewHostManager delivers it to
  // the right WebContentsView; a view posts a message -> the supervisor
  // forwards it to the owning host). Forward-declare one side; both
  // closures below only ever fire after everything is constructed.
  let supervisor!: ExtensionHostSupervisor;
  const output = new OutputService();

  // Core views talk to core services; plugin views to their plugin's extension host.
  let workspace!: WorkspaceService;
  let terminal!: TerminalService;
  const views = new ViewHostManager(mainWindow, join(__dirname, "../preload"), (pluginId, viewId, connectionId, message) => {
    if (pluginId !== CORE_PLUGIN_ID) return supervisor.sendViewMessage(pluginId, viewId, connectionId, message);
    if (viewId === EDITOR_VIEW) workspace.onEditorMessage(connectionId, message);
    else if (viewId === TERMINAL_VIEW) terminal.fromView(message);
  });

  supervisor = new ExtensionHostSupervisor(
    secrets,
    (pluginId, msg) => {
      const c = msg.contribution;
      if (c.kind === "connection") {
        providers.registerConnection({ pluginId, typeId: c.typeId, configSchema: c.configSchema as never, uiSchema: c.uiSchema as never });
      } else if (c.kind === "explorer") {
        providers.registerExplorer(pluginId, c.nodeTypes);
      } else if (c.kind === "command") {
        providers.registerCommand(pluginId, c.commandId);
      }
    },
    (pluginId, code) => {
      providers.removeForPlugin(pluginId);
      pluginManager.setState(pluginId, "crashed", `Extension host exited unexpectedly (code ${code}).`);
    },
    log,
    (pluginId, viewId, connectionId, message) => views.push(viewId, connectionId, message),
    output,
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
    (pluginId, kind, target, method, args, connectionId) =>
      supervisor.invoke(pluginId, kind, target, method, args, connectionId),
    (pluginId) => pluginManager.getRecord(pluginId)?.manifest?.version,
  );

  // The workspace (core): the folders open in the Explorer — its tree, file commands, the editor's backend and
  // text search on a worker thread. Shared with every plugin through context.workspace.
  const searchWorker = new SearchWorker();
  workspace = new WorkspaceService(config, searchWorker, (viewId, folderId, message) => views.push(viewId, folderId, message));
  // The integrated terminal (core): shells in their own process; new terminals start in the first open folder.
  terminal = new TerminalService(
    (message) => views.push(TERMINAL_VIEW, undefined, message),
    () => workspace.folders()[0]?.path,
  );
  /** Commands implemented by core itself (files.*, terminal.*): views, menus and context menus call them by id. */
  const coreCommands = { ...workspace.commands(), ...terminal.commands() };

  async function openWorkspaceFile(path: string, options: { line?: number | undefined; column?: number | undefined; length?: number | undefined } = {}): Promise<void> {
    const location = workspace.locate(path);
    if (!location) throw new Error(`"${path}" isn't inside a folder open in the Explorer.`);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannel.WorkspaceOpenFile, { folderId: location.folder.id, relPath: location.relPath });
    }
    // The editor tab picks this up when it has loaded (or right away if it's open already).
    if (options.line) workspace.reveal(location.folder.id, { path: location.relPath, line: options.line, col: options.column ?? 1, length: options.length ?? 0 });
  }
  supervisor.setWorkspace({ folders: () => workspace.folders().map(({ name, path }) => ({ name, path })), openFile: openWorkspaceFile });
  views.setOpenFileHandler(openWorkspaceFile);
  workspace.onChanged((folders) => {
    supervisor.broadcastWorkspaceFolders(folders.map(({ name, path }) => ({ name, path })));
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IpcChannel.WorkspaceChanged, folders);
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
    getWindows: () => BrowserWindow.getAllWindows(),
    workspace,
    openWorkspaceFile,
    coreCommands,
    coreViewUrl,
    terminal,
  });

  await pluginManager.scan();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  app.on("before-quit", () => {
    views.closeAll();
    terminal.dispose();
    void searchWorker.dispose();
    for (const record of pluginManager.getRecords()) {
      if (record.state === "active") void supervisor.deactivate(record.id);
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void main();
