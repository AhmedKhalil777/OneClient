import { BrowserWindow, ipcMain } from "electron";
import type { RpcHost } from "@oneclient/backend/rpc/rpc-host.js";

/** The desktop transport: Electron IPC to every window. */
export function electronRpc(): RpcHost {
  return {
    handle: (channel, handler) => ipcMain.handle(channel, (event, ...args) => handler(event, ...args)),
    on: (channel, handler) => ipcMain.on(channel, (event, ...args) => handler(event, ...args)),
    broadcast(channel, payload) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      }
    },
  };
}
