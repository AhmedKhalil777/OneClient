import { join } from "node:path";
import { BrowserWindow, app, shell } from "electron";

/** Must match the first grid row of `.app` in the renderer's styles.css. */
const TITLE_BAR_HEIGHT = 34;

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: "oneClient",
    // The shell draws its own title bar (logo, menus, search); the OS keeps the window buttons, drawn over it.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 12, y: 10 } }
      : { titleBarOverlay: { color: "#1f1f1f", symbolColor: "#cccccc", height: TITLE_BAR_HEIGHT } }),
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
