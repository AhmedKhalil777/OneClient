import { join } from "node:path";
import { BrowserWindow, app } from "electron";
import { registerPluginAssetProtocolHandler, registerPluginAssetSchemeAsPrivileged } from "./assets/plugin-asset-protocol.js";

// Must run before any app.getPath("userData") call — otherwise Electron
// derives the userData folder name from package.json's "name" field
// ("@oneclient/core"), which makes an ugly on-disk path.
app.setName("oneClient");
// Must run before app.whenReady() — see plugin-asset-protocol.ts.
registerPluginAssetSchemeAsPrivileged();
import { openDatabase } from "./db/database.js";
import { PluginMetadataStore } from "./db/plugin-metadata-store.js";
import { ConnectionManager } from "./connections/connection-manager.js";
import { registerIpcHandlers } from "./ipc/handlers.js";
import { ExtensionHostSupervisor } from "./plugins/extension-host-supervisor.js";
import { PluginManager, type PluginRecord } from "./plugins/plugin-manager.js";
import { ProviderDirectory } from "./plugins/provider-directory.js";
import { ContributionRegistry } from "./plugins/registry.js";
import { SqliteSecretStore } from "./secrets/secret-store.js";
import { ViewHostManager } from "./views/view-host-manager.js";
import { createMainWindow } from "./windows.js";

function pluginDirs(): string[] {
  const dirs = [join(app.getPath("userData"), "plugins")];
  if (app.isPackaged) {
    // Built-in plugins (e.g. oneclient-files) ship inside the app bundle's
    // resources — the packaging step copies packages/plugins/<built-in> there.
    dirs.push(join(process.resourcesPath, "plugins"));
  } else {
    // Dev-only fixture plugin(s) for exercising the loader/extension-host pipeline
    // without a real install flow — see packages/core/dev-plugins/README.md.
    dirs.push(join(__dirname, "../../dev-plugins"));
    // Real reference plugins (packages/plugins/*) load live from the repo in
    // dev builds too, same as a packaged app's built-in extensions would —
    // no install step needed while developing them.
    dirs.push(join(__dirname, "../../../plugins"));
  }
  return dirs;
}

function log(pluginId: string, level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown): void {
  const prefix = `[plugin:${pluginId}]`;
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](prefix, message, meta ?? "");
}

async function main(): Promise<void> {
  await app.whenReady();

  const db = openDatabase(join(app.getPath("userData"), "oneclient.sqlite3"));
  const metadata = new PluginMetadataStore(db);
  const registry = new ContributionRegistry();
  const providers = new ProviderDirectory();
  const secrets = new SqliteSecretStore(db);
  const pluginManager = new PluginManager(pluginDirs(), registry, metadata);
  registerPluginAssetProtocolHandler(pluginManager);

  const mainWindow = createMainWindow();

  // ExtensionHostSupervisor and ViewHostManager each need to call into the
  // other (a host pushes a view message -> ViewHostManager delivers it to
  // the right WebContentsView; a view posts a message -> the supervisor
  // forwards it to the owning host). Forward-declare one side; both
  // closures below only ever fire after everything is constructed.
  let supervisor!: ExtensionHostSupervisor;

  const views = new ViewHostManager(
    mainWindow,
    join(__dirname, "../preload"),
    (pluginId, viewId, connectionId, message) => supervisor.sendViewMessage(pluginId, viewId, connectionId, message),
  );

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
  );

  async function tryActivate(record: PluginRecord): Promise<void> {
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
    db,
    registry,
    providers,
    secrets,
    ensureActivated,
    (pluginId, kind, target, method, args, connectionId) =>
      supervisor.invoke(pluginId, kind, target, method, args, connectionId),
  );

  registerIpcHandlers({
    registry,
    pluginManager,
    connections,
    supervisor,
    views,
    ensureActivated,
    getWindows: () => BrowserWindow.getAllWindows(),
  });

  await pluginManager.scan();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  app.on("before-quit", () => {
    views.closeAll();
    for (const record of pluginManager.getRecords()) {
      if (record.state === "active") void supervisor.deactivate(record.id);
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void main();
