import { contextBridge, ipcRenderer } from "electron";
import type { ThemeState, ViewHostApi } from "@oneclient/plugin-api";

/**
 * Preload for a Tier 2 view's WebContentsView — a completely separate,
 * isolated surface from the main app shell's preload (index.ts). The
 * plugin's view-side JS only ever sees `window.oneclientView`
 * (`ViewHostApi`); it has no access to ipcRenderer, Node, or the rest of
 * the app. Which plugin/view/connection this instance belongs to is
 * main-process state (ViewHostManager) — this preload is generic and
 * reused for every Tier 2 view from every plugin.
 *
 * It also applies the active theme to the page: every color key becomes a
 * `--oc-*` CSS variable on <html> (plus `data-oc-theme` and `color-scheme`),
 * so plugin CSS written against those variables follows theme switches
 * with no plugin code at all.
 */

const listeners = new Set<(message: unknown) => void>();
const themeListeners = new Set<(theme: ThemeState) => void>();
let theme: ThemeState | null = null;

ipcRenderer.on("oneclient-view:push", (_event, message: unknown) => {
  for (const listener of listeners) listener(message);
});

// Inlined (not imported from plugin-api): a sandboxed preload can't require workspace packages.
const varName = (key: string) => `--oc-${key.replace(/\./g, "-")}`;

// The preload builds with Node typings (no DOM lib) — describe just what's used.
interface RootElement {
  style: { setProperty(name: string, value: string): void; colorScheme: string };
  dataset: Record<string, string | undefined>;
}
const pageDocument = (
  globalThis as unknown as {
    document: { documentElement: RootElement | null; addEventListener(type: string, fn: () => void, opts?: { once: boolean }): void };
  }
).document;

function applyTheme(next: ThemeState) {
  theme = next;
  const root = pageDocument.documentElement;
  // The theme can arrive before the page has an <html> element (preloads run that early): apply once it does.
  if (!root) {
    pageDocument.addEventListener("DOMContentLoaded", () => applyTheme(theme ?? next), { once: true });
    return;
  }
  for (const [key, value] of Object.entries(next.colors)) root.style.setProperty(varName(key), value);
  root.dataset.ocTheme = next.colorTheme.kind;
  root.style.colorScheme = next.colorTheme.kind === "light" ? "light" : "dark";
  for (const listener of themeListeners) listener(next);
}

ipcRenderer.on("oneclient-view:theme", (_event, next: ThemeState) => applyTheme(next));
void ipcRenderer.invoke("oneclient-view:get-theme").then((initial: ThemeState) => {
  if (!theme) applyTheme(initial);
});

const api: ViewHostApi = {
  postMessage: (message) => ipcRenderer.send("oneclient-view:post", message),
  onMessage: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  invokeCommand: (commandId, args) => ipcRenderer.invoke("oneclient:command:execute", commandId, args),
  setDirty: (dirty) => ipcRenderer.send("oneclient-view:dirty", Boolean(dirty)),
  revealView: (viewId) => ipcRenderer.send("oneclient-view:reveal", String(viewId)),
  getTheme: () => theme,
  getContributions: (point) => ipcRenderer.invoke("oneclient-view:get-contributions", point),
  openExternal: (url) => ipcRenderer.send("oneclient-view:open-external", String(url)),
  openView: (request) => ipcRenderer.send("oneclient-view:open-view", request),
  refreshExplorer: () => ipcRenderer.send("oneclient-view:refresh-explorer"),
  openFile: (path, options) => ipcRenderer.invoke("oneclient-view:open-file", String(path), options ?? {}),
  onThemeChange: (listener) => {
    themeListeners.add(listener);
    if (theme) listener(theme);
    return () => themeListeners.delete(listener);
  },
};

contextBridge.exposeInMainWorld("oneclientView", api);
