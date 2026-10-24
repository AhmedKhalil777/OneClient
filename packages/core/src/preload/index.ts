import { contextBridge, ipcRenderer } from "electron";
import { createClientApi } from "@oneclient/backend/shared/client-api.js";

// The shell's API over Electron IPC — the same object the web bridge builds over its WebSocket.
const api = createClientApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on(channel, listener) {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});

contextBridge.exposeInMainWorld("oneclient", api);
