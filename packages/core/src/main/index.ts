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
import { ConfigVersionError, oneclientHome } from "@oneclient/backend/config/config-store.js";
import { InstanceLockError, acquireInstanceLock } from "@oneclient/backend/config/instance-lock.js";
import { type Backend, createBackend } from "@oneclient/backend/backend.js";
import { electronDialogs, registerElectronHandlers } from "./ipc/electron-handlers.js";
import { electronPlatform } from "./platform/electron-platform.js";
import { electronRpc } from "./rpc/electron-rpc.js";
import { ViewHostManager } from "./views/view-host-manager.js";
import { createMainWindow } from "./windows.js";

/**
 * The desktop app: the shared backend (backend.ts) in Electron's main process, with native windows and views.
 * The web runtime (server/main.ts) runs the same backend on plain Node instead.
 */

function pluginDirs(): string[] {
  const dirs = [join(app.getPath("userData"), "plugins")];
  // Bundled plugins ship inside the app bundle's resources (the packaging step copies packages/plugins/* there);
  // in dev builds they load live from the repo, no install step needed.
  dirs.push(app.isPackaged ? join(process.resourcesPath, "plugins") : join(__dirname, "../../../plugins"));
  return dirs;
}

/** A core view page (the file editor tab, the Terminal panel…): the renderer build, or the dev server. */
function coreViewUrl(page: string): string {
  const devServer = process.env["ELECTRON_RENDERER_URL"];
  return !app.isPackaged && devServer ? `${devServer}/${page}` : pathToFileURL(join(__dirname, "../renderer", page)).href;
}

async function main(): Promise<void> {
  // One installed instance: launching again focuses the running window instead of starting another app.
  // Dev builds skip this so they can run alongside an installed copy (and the test driver).
  if (app.isPackaged) {
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    app.on("second-instance", () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  }

  await app.whenReady();

  // The web server may be using the same config folder; two runtimes on one folder would overwrite each other's saves.
  let releaseLock: () => void;
  try {
    releaseLock = acquireInstanceLock(oneclientHome(), "desktop");
  } catch (err) {
    if (!(err instanceof InstanceLockError)) throw err;
    dialog.showErrorBox("oneClient is already running as a web server", err.message);
    app.quit();
    return;
  }
  app.on("will-quit", () => releaseLock());

  const mainWindow = createMainWindow();
  let backend: Backend;
  try {
    backend = await createBackend({
      platform: electronPlatform(pluginDirs()),
      rpc: electronRpc(),
      createViews: (onMessageFromView) => new ViewHostManager(mainWindow, join(__dirname, "../preload"), onMessageFromView, coreViewUrl),
      dialogs: electronDialogs,
      onAssetsReady: (pluginManager, themes) => registerPluginAssetProtocolHandler(pluginManager, (id) => themes.resolveIconFile(id)),
    });
  } catch (err) {
    if (err instanceof ConfigVersionError) {
      // A newer oneClient wrote these files; opening them with this one could lose data, so stop here.
      dialog.showErrorBox("oneClient can't open its settings", err.message);
      app.quit();
      return;
    }
    throw err;
  }
  registerElectronHandlers({ views: backend.views as ViewHostManager, config: backend.config, workspace: backend.workspace, gitService: backend.gitService });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  app.on("before-quit", () => {
    void backend.dispose();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void main();
