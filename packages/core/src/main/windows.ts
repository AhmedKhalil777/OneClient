import { join } from "node:path";
import { BrowserWindow, app, shell } from "electron";

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: "oneClient",
    backgroundColor: "#1e1e1e",
    // out/main → packages/core/resources (regenerate from logo.svg with `pnpm run icons`).
    icon: join(__dirname, "../../resources/icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on("ready-to-show", () => win.show());

  // Open any target="_blank"/window.open() link in the OS browser instead of a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}
