import type { ThemeState, ViewHostApi } from "@oneclient/plugin-api";
import { colorVarName } from "@oneclient/plugin-api";
import { createClientApi } from "@oneclient/backend/shared/client-api.js";
import { IpcChannel, type OneClientApi, type ViewKey, type WindowAction, type WorkbenchShortcut } from "@oneclient/backend/shared/ipc-contract.js";
import { workbenchShortcut } from "@oneclient/backend/shared/shortcuts.js";
import { ASSET_PREFIX, type ClientMessage, type ServerMessage, type ViewEventKind, WS_PATH } from "@oneclient/backend/shared/web-protocol.js";
import { pickFolder } from "./folder-picker.js";

/**
 * The web runtime's side of the shell: what the desktop gets from its preloads and Electron, built on the server's
 * WebSocket. Installs `window.oneclient` (the same API object the preload builds — see createClientApi) and hosts
 * Tier 2 views as same-origin iframes, each given its `window.oneclientView` by the injected view bridge.
 */

interface ViewFrame {
  instanceId: string;
  frame: HTMLIFrameElement;
  listeners: Set<(message: unknown) => void>;
  themeListeners: Set<(theme: ThemeState) => void>;
}

export async function installWebBridge(): Promise<void> {
  (globalThis as { __ONECLIENT_ASSET_BASE__?: string }).__ONECLIENT_ASSET_BASE__ = `${location.origin}${ASSET_PREFIX}`;

  // ---- the socket ----
  const socket = await connect();
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
  const frames = new Map<string, ViewFrame>();
  const send = (msg: ClientMessage) => socket.send(JSON.stringify(msg));

  socket.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data)) as ServerMessage;
    if (msg.t === "result") {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok) p?.resolve(msg.value);
      else p?.reject(new Error(msg.error));
    } else if (msg.t === "event") {
      for (const listener of eventListeners.get(msg.ch) ?? []) listener(msg.payload);
    } else if (msg.t === "view") {
      for (const listener of frames.get(msg.inst)?.listeners ?? []) listener(msg.payload);
    }
  });
  // The server restarted or the network dropped: views and subscriptions are gone server-side, so start over.
  socket.addEventListener("close", () => showDisconnected());

  const invoke = (channel: string, ...args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ t: "call", id, ch: channel, args });
    });
  const on = (channel: string, listener: (payload: unknown) => void) => {
    const set = eventListeners.get(channel) ?? new Set();
    set.add(listener);
    eventListeners.set(channel, set);
    return () => void set.delete(listener);
  };
  const emitLocal = (channel: string, payload: unknown) => {
    for (const listener of eventListeners.get(channel) ?? []) listener(payload);
  };
  const viewEvent = (inst: string, kind: ViewEventKind, payload?: unknown) => send({ t: "view", inst, kind, ...(payload === undefined ? {} : { payload }) });

  const api: OneClientApi = createClientApi({ invoke, on });

  // ---- theme for views (the desktop's view preload applies it; here the shell does) ----
  let viewTheme: ThemeState | null = null;
  const forViews = (state: ThemeState): ThemeState => {
    const { fileIcons: _shellOnly, ...rest } = state;
    return rest;
  };
  const applyTheme = (win: Window, theme: ThemeState) => {
    const root = win.document.documentElement;
    for (const [key, value] of Object.entries(theme.colors)) root.style.setProperty(colorVarName(key), value);
    root.dataset.ocTheme = theme.colorTheme.kind;
    root.style.colorScheme = theme.colorTheme.kind === "light" ? "light" : "dark";
  };
  on(IpcChannel.ThemeChanged, (state) => {
    viewTheme = forViews(state as ThemeState);
    for (const f of frames.values()) {
      if (f.frame.contentWindow) applyTheme(f.frame.contentWindow, viewTheme);
      for (const listener of f.themeListeners) listener(viewTheme);
    }
  });
  viewTheme = forViews((await invoke(IpcChannel.ThemeGetState)) as ThemeState);

  // ---- views: iframes mounted inside each Tier2ViewHost's placeholder ----
  (window as unknown as { __oneclientViewHost: { attach(win: Window): ViewHostApi } }).__oneclientViewHost = {
    attach(win: Window): ViewHostApi {
      const view = [...frames.values()].find((f) => f.frame.contentWindow === win);
      if (!view) throw new Error("Unknown view frame.");
      const inst = view.instanceId;
      if (viewTheme) applyTheme(win, viewTheme);
      // A focused iframe gets every key press: hand workbench shortcuts to the shell, as the desktop does.
      win.addEventListener(
        "keydown",
        (e) => {
          const shortcut = workbenchShortcut({ key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey });
          if (!shortcut) return;
          e.preventDefault();
          e.stopPropagation();
          emitLocal(IpcChannel.Shortcut, shortcut satisfies WorkbenchShortcut);
        },
        true,
      );
      return {
        postMessage: (message) => viewEvent(inst, "post", message),
        onMessage: (listener) => {
          view.listeners.add(listener);
          return () => view.listeners.delete(listener);
        },
        invokeCommand: (commandId, args) => invoke(IpcChannel.CommandExecute, commandId, args),
        setDirty: (dirty) => viewEvent(inst, "dirty", Boolean(dirty)),
        revealView: (viewId) => viewEvent(inst, "reveal", String(viewId)),
        getTheme: () => viewTheme,
        getContributions: (point) => invoke("oneclient-view:get-contributions", point) as never,
        openExternal: (url) => {
          try {
            const parsed = new URL(String(url));
            if (["http:", "https:", "mailto:"].includes(parsed.protocol)) window.open(parsed.toString(), "_blank", "noopener,noreferrer");
          } catch {
            /* not a URL */
          }
        },
        openView: (request) => viewEvent(inst, "open-view", request),
        refreshExplorer: () => viewEvent(inst, "refresh-explorer"),
        openFile: (path, options) => invoke("oneclient-view:open-file", String(path), options ?? {}) as Promise<boolean>,
        onThemeChange: (listener) => {
          view.themeListeners.add(listener);
          if (viewTheme) listener(viewTheme);
          return () => view.themeListeners.delete(listener);
        },
      };
    },
  };

  const frameWindow = (instanceId?: string) => (instanceId ? frames.get(instanceId)?.frame.contentWindow : null) ?? null;

  api.openView = async (instanceId, pluginId, viewId, connectionId, params) => {
    if (frames.has(instanceId)) return;
    const { url } = (await invoke(IpcChannel.ViewOpen, instanceId, pluginId, viewId, connectionId, params)) as { url: string };
    const slot = document.querySelector<HTMLElement>(`[data-view-instance="${CSS.escape(instanceId)}"]`);
    if (!slot) return; // closed while opening
    const frame = document.createElement("iframe");
    frame.className = "web-view-frame";
    frame.title = viewId;
    frame.allow = "clipboard-read; clipboard-write; fullscreen";
    frame.style.cssText = "border:0;width:100%;height:100%;display:block;background:transparent";
    frames.set(instanceId, { instanceId, frame, listeners: new Set(), themeListeners: new Set() });
    frame.src = url;
    slot.appendChild(frame);
  };
  api.closeView = async (instanceId) => {
    const view = frames.get(instanceId);
    frames.delete(instanceId);
    view?.frame.remove();
    await invoke(IpcChannel.ViewClose, instanceId);
  };
  // Placement is plain CSS: the iframe fills its placeholder (which hides with its tab).
  api.setViewBounds = async () => undefined;
  api.focusView = async (instanceId) => frameWindow(instanceId)?.focus();

  // ---- window and edit actions, in the page ----
  api.windowAction = async (action: WindowAction) => {
    switch (action) {
      case "toggleFullScreen":
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
        return;
      case "reload":
        location.reload();
        return;
      case "zoomIn":
      case "zoomOut":
      case "zoomReset": {
        const current = Number(document.documentElement.style.getPropertyValue("zoom") || 1);
        const next = action === "zoomReset" ? 1 : Math.min(2.5, Math.max(0.5, current + (action === "zoomIn" ? 0.1 : -0.1)));
        document.documentElement.style.setProperty("zoom", String(Math.round(next * 10) / 10));
        return;
      }
      default:
        // Dev tools, quit and the config folder belong to the browser / the server machine.
        return;
    }
  };
  api.onFullScreenChanged = (listener) => {
    const handler = () => listener(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  };
  api.setTitleBarColors = async () => undefined;
  api.editAction = async (role, instanceId) => {
    const win = frameWindow(instanceId) ?? window;
    win.focus();
    if (role === "paste") {
      const text = await navigator.clipboard.readText().catch(() => "");
      if (text) win.document.execCommand("insertText", false, text);
      return;
    }
    win.document.execCommand(role);
  };
  api.sendKeyToView = async (instanceId, key: ViewKey) => {
    const win = frameWindow(instanceId);
    if (!win) return;
    win.focus();
    const k = key.key.length === 1 ? (key.shift ? key.key.toUpperCase() : key.key.toLowerCase()) : key.key;
    const init = { key: k, ctrlKey: !!key.ctrl, shiftKey: !!key.shift, altKey: !!key.alt, bubbles: true, cancelable: true };
    const target = win.document.activeElement ?? win.document.body;
    target.dispatchEvent(new (win as unknown as typeof globalThis).KeyboardEvent("keydown", init));
    target.dispatchEvent(new (win as unknown as typeof globalThis).KeyboardEvent("keyup", init));
  };

  // ---- dialogs: in the page instead of native ones ----
  api.pickDirectory = (defaultPath) => pickFolder((path) => invoke("oneclient-web:list-dirs", path) as never, defaultPath);
  api.exportConnections = async (includeSecrets) => {
    const result = (await invoke(IpcChannel.ConnectionExport, includeSecrets)) as { path: string; count: number; includesSecrets: boolean; document?: unknown } | null;
    if (!result?.document) return result;
    const blob = new Blob([`${JSON.stringify(result.document, null, 2)}\n`], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = result.path;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    return { path: `${result.path} (downloaded)`, count: result.count, includesSecrets: result.includesSecrets };
  };
  api.importConnections = async () => {
    const file = await chooseFile(".json,application/json");
    if (!file) return null;
    let document: unknown;
    try {
      document = JSON.parse(await file.text());
    } catch (err) {
      throw new Error(`${file.name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return invoke(IpcChannel.ConnectionImport, { name: file.name, document }) as never;
  };
  // The OS file manager is on the server machine — nothing to show in the browser.
  api.revealConfigFile = async () => undefined;
  api.revealPath = async () => undefined;

  (window as unknown as { oneclient: OneClientApi }).oneclient = api;
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${WS_PATH}`);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("Can't reach the oneClient server.")), { once: true });
  });
}

function chooseFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

function showDisconnected(): void {
  if (document.getElementById("oc-disconnected")) return;
  const overlay = document.createElement("div");
  overlay.id = "oc-disconnected";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:100000;display:grid;place-items:center;background:rgba(0,0,0,.55);font:14px system-ui;color:#eee";
  overlay.innerHTML = `<div style="background:#252526;border:1px solid #444;border-radius:8px;padding:20px 24px;max-width:380px;text-align:center">
    <div style="font-weight:600;margin-bottom:6px">Disconnected from the oneClient server</div>
    <div style="color:#aaa">Reconnecting…</div></div>`;
  document.body.appendChild(overlay);
  // Reload once the server answers again (the page needs a fresh session and views).
  const retry = () =>
    fetch(location.pathname, { method: "HEAD", cache: "no-store" })
      .then((r) => (r.ok ? location.reload() : setTimeout(retry, 2000)))
      .catch(() => setTimeout(retry, 2000));
  setTimeout(retry, 1000);
}
