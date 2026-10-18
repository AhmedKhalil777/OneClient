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

  // `ready-to-show` waits for the first paint, and Chromium can skip painting a window that was never shown,
  // which left the installed app running with no window. Also show once the page has loaded, or after a timeout.
  let shown = false;
  const reveal = (): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  win.once("ready-to-show", reveal);
  win.webContents.once("did-finish-load", reveal);
  setTimeout(reveal, 3000);

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
