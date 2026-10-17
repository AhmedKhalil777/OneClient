import { contextBridge, ipcRenderer } from "electron";
import type { ViewHostApi } from "@oneclient/plugin-api";

/**
 * Preload for a Tier 2 view's WebContentsView — a completely separate,
 * isolated surface from the main app shell's preload (index.ts). The
 * plugin's view-side JS only ever sees `window.oneclientView`
 * (`ViewHostApi`); it has no access to ipcRenderer, Node, or the rest of
 * the app. Which plugin/view/connection this instance belongs to is
 * main-process state (ViewHostManager) — this preload is generic and
 * reused for every Tier 2 view from every plugin.
 */

const listeners = new Set<(message: unknown) => void>();

ipcRenderer.on("oneclient-view:push", (_event, message: unknown) => {
  for (const listener of listeners) listener(message);
});

const api: ViewHostApi = {
  postMessage: (message) => ipcRenderer.send("oneclient-view:post", message),
  onMessage: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  invokeCommand: (commandId, args) => ipcRenderer.invoke("oneclient:command:execute", commandId, args),
  setDirty: (dirty) => ipcRenderer.send("oneclient-view:dirty", Boolean(dirty)),
};

contextBridge.exposeInMainWorld("oneclientView", api);
