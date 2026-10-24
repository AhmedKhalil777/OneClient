import { dirname, join } from "node:path";
import { BrowserWindow, type OpenDialogOptions, app, dialog, ipcMain, shell } from "electron";
import { type EditRole, IpcChannel, type ViewBounds, type ViewKey, type WindowAction } from "@oneclient/backend/shared/ipc-contract.js";
import type { ConfigStore } from "@oneclient/backend/config/config-store.js";
import type { GitService } from "@oneclient/backend/git/git-service.js";
import type { ViewHostManager } from "../views/view-host-manager.js";
import type { WorkspaceService } from "@oneclient/backend/workspace/workspace-service.js";
import type { FileDialogs } from "@oneclient/backend/rpc/handlers.js";

const dialogParent = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

/** Native save/open dialogs for export / import. */
export const electronDialogs: FileDialogs = {
  async save(_caller, { title, defaultName }) {
    const parent = dialogParent();
    const options = { title, defaultPath: join(app.getPath("documents"), defaultName), filters: [{ name: "JSON", extensions: ["json"] }] };
    const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    return picked.canceled || !picked.filePath ? null : picked.filePath;
  },
  async open(_caller, { title }) {
    const parent = dialogParent();
    const options: OpenDialogOptions = { title, properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] };
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  },
};

/** What only the desktop app has: windows, the OS file manager, native dialogs and native views. */
export function registerElectronHandlers(deps: { views: ViewHostManager; config: ConfigStore; workspace: WorkspaceService; gitService: GitService }): void {
  const { views, config, workspace, gitService } = deps;

  // A sandboxed view can't open links itself; main does it, for web/mail links only.
  ipcMain.on("oneclient-view:open-external", (_e, url: unknown) => {
    try {
      const parsed = new URL(String(url));
      if (["http:", "https:", "mailto:"].includes(parsed.protocol)) void shell.openExternal(parsed.toString());
    } catch {
      /* not a URL */
    }
  });
  ipcMain.handle(IpcChannel.ViewFocus, (_event, instanceId: string) => views.focus(instanceId));
  ipcMain.handle(IpcChannel.ViewSetBounds, (_event, instanceId: string, bounds: ViewBounds) => views.setBounds(instanceId, bounds));
  ipcMain.handle(IpcChannel.ConfigReveal, () => shell.showItemInFolder(config.filePath));
  ipcMain.handle(IpcChannel.RevealPath, (_e, path: unknown) => {
    // Only paths inside the workspace: a page can't make the shell open arbitrary locations.
    if (typeof path === "string" && (workspace.locate(path) || workspace.folders().some((f) => f.path === path))) shell.showItemInFolder(path);
  });
  ipcMain.handle(IpcChannel.DialogPickDirectory, async (event, defaultPath?: string): Promise<string | null> => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"], ...(defaultPath ? { defaultPath } : {}) };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // Title bar menus.
  const windowOf = (event: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender) ?? dialogParent();
  ipcMain.handle(IpcChannel.WindowAction, (event, action: WindowAction) => {
    const win = windowOf(event);
    const wc = win?.webContents;
    const zoom = (delta: number | null) => {
      if (!wc) return;
      const level = delta === null ? 0 : Math.max(-3, Math.min(5, wc.getZoomLevel() + delta));
      wc.setZoomLevel(level);
      views.setZoomLevel(level);
    };
    switch (action) {
      case "toggleDevTools":
        return wc?.toggleDevTools();
      case "toggleFullScreen":
        return win?.setFullScreen(!win.isFullScreen());
      case "zoomIn":
        return zoom(0.5);
      case "zoomOut":
        return zoom(-0.5);
      case "zoomReset":
        return zoom(null);
      case "reload":
        return wc?.reload();
      case "quit":
        return app.quit();
      case "revealConfigFolder":
        return void shell.openPath(dirname(config.filePath));
    }
  });
  ipcMain.handle(IpcChannel.EditAction, (event, role: EditRole, instanceId?: string) => {
    const wc = (instanceId ? views.webContentsOf(instanceId) : undefined) ?? event.sender;
    if (!["undo", "redo", "cut", "copy", "paste", "selectAll"].includes(role)) return;
    if (instanceId) wc.focus();
    wc[role]();
  });
  ipcMain.handle(IpcChannel.ViewSendKey, (_e, instanceId: string, key: ViewKey) => {
    const wc = views.webContentsOf(String(instanceId));
    if (!wc || typeof key?.key !== "string") return;
    const modifiers = [key.ctrl ? "control" : null, key.shift ? "shift" : null, key.alt ? "alt" : null].filter((m): m is "control" | "shift" | "alt" => m !== null);
    wc.focus();
    wc.sendInputEvent({ type: "keyDown", keyCode: key.key, modifiers });
    if (key.key.length === 1 && !key.ctrl && !key.alt) wc.sendInputEvent({ type: "char", keyCode: key.key, modifiers });
    wc.sendInputEvent({ type: "keyUp", keyCode: key.key, modifiers });
  });
  ipcMain.handle(IpcChannel.TitleBarColors, (event, background: string, foreground: string) => {
    const win = windowOf(event);
    if (!win || process.platform === "darwin" || typeof background !== "string" || typeof foreground !== "string") return;
    try {
      win.setTitleBarOverlay({ color: background, symbolColor: foreground });
    } catch {
      // the window was created without an overlay (e.g. a native frame) — nothing to recolour
    }
  });
  for (const win of BrowserWindow.getAllWindows()) {
    win.on("focus", () => gitService.scheduleRefresh());
    win.on("enter-full-screen", () => win.webContents.send(IpcChannel.FullScreenChanged, true));
    win.on("leave-full-screen", () => win.webContents.send(IpcChannel.FullScreenChanged, false));
  }
}
