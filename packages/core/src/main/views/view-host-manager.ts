import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type BrowserWindow, WebContentsView, ipcMain } from "electron";
import type { OpenViewRequest } from "@oneclient/plugin-api";
import type { WorkbenchShortcut } from "../../shared/ipc-contract.js";

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ViewInstance {
  instanceId: string;
  pluginId: string;
  viewId: string;
  connectionId?: string;
  view: WebContentsView;
}

type MessageFromViewFn = (pluginId: string, viewId: string, connectionId: string | undefined, message: unknown) => void;

/**
 * Owns the WebContentsViews backing open Tier 2 view instances, attached
 * as native child views layered over the main BrowserWindow's content
 * area (not part of the renderer's DOM — see ARCHITECTURE.md § Tier 2
 * views for why this is WebContentsView rather than the legacy
 * `<webview>` tag). The renderer only ever talks to this through
 * open/close/setBounds IPC calls; it never gets a handle to the view
 * itself.
 *
 * One `WebContentsView` per open *instance* (viewId + connectionId pair),
 * so two connections of the same type can have their dashboards open in
 * separate tabs simultaneously.
 */
export class ViewHostManager {
  private readonly instances = new Map<string, ViewInstance>();
  private readonly viewPreloadPath: string;

  constructor(
    private readonly window: BrowserWindow,
    preloadDir: string,
    private readonly onMessageFromView: MessageFromViewFn,
  ) {
    this.viewPreloadPath = join(preloadDir, "view.js");

    // Global on purpose: one handler for every view instance's webContents,
    // disambiguated by matching event.sender. (webContents.ipc is a newer
    // Electron API; matching event.sender here works across versions.)
    ipcMain.on("oneclient-view:post", (event, message: unknown) => {
      const instance = [...this.instances.values()].find((i) => i.view.webContents === event.sender);
      if (instance) this.onMessageFromView(instance.pluginId, instance.viewId, instance.connectionId, message);
    });
    ipcMain.on("oneclient-view:open-view", (event, request: unknown) => {
      const instance = [...this.instances.values()].find((i) => i.view.webContents === event.sender);
      const r = request as Partial<OpenViewRequest> | null;
      if (!instance || !r || typeof r.viewId !== "string" || typeof r.title !== "string") return;
      // pluginId/connectionId come from main-side state, never from the page: a view can only open its own plugin's views.
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.params ?? {})) if (typeof v === "string") params[k] = v;
      const clean: OpenViewRequest = { viewId: r.viewId, title: r.title, params, ...(typeof r.icon === "string" ? { icon: r.icon } : {}) };
      for (const listener of this.openViewListeners) listener(instance.pluginId, instance.connectionId, clean);
    });
    ipcMain.handle("oneclient-view:open-file", async (_event, path: unknown, options: unknown) => {
      if (typeof path !== "string" || !this.openFileHandler) return false;
      const o = (options ?? {}) as { line?: unknown; column?: unknown; length?: unknown };
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      try {
        await this.openFileHandler(path, { line: num(o.line), column: num(o.column), length: num(o.length) });
        return true;
      } catch {
        return false;
      }
    });
    ipcMain.on("oneclient-view:refresh-explorer", (event) => {
      const instance = [...this.instances.values()].find((i) => i.view.webContents === event.sender);
      // Only the view's own connection (from main-side state) can be refreshed.
      if (instance?.connectionId) for (const listener of this.refreshListeners) listener(instance.connectionId);
    });
    ipcMain.on("oneclient-view:reveal", (event, viewId: unknown) => {
      const instance = [...this.instances.values()].find((i) => i.view.webContents === event.sender);
      // Only the requesting plugin's own views can be revealed (pluginId comes from main-side state).
      if (instance && typeof viewId === "string") for (const listener of this.revealListeners) listener(instance.pluginId, viewId);
    });
    ipcMain.on("oneclient-view:dirty", (event, dirty: unknown) => {
      const instance = [...this.instances.values()].find((i) => i.view.webContents === event.sender);
      if (instance) for (const listener of this.dirtyListeners) listener(instance.instanceId, dirty === true);
    });
  }

  private readonly dirtyListeners = new Set<(instanceId: string, dirty: boolean) => void>();
  private readonly refreshListeners = new Set<(connectionId: string) => void>();

  /** A view asked for its connection's explorer tree to be re-fetched. */
  private openFileHandler: ((path: string, options: { line?: number | undefined; column?: number | undefined; length?: number | undefined }) => Promise<void>) | undefined;
  /** Serves `window.oneclientView.openFile` (core's workspace opens the file in the editor). */
  setOpenFileHandler(handler: NonNullable<ViewHostManager["openFileHandler"]>): void {
    this.openFileHandler = handler;
  }

  onRefreshExplorer(listener: (connectionId: string) => void): () => void {
    this.refreshListeners.add(listener);
    return () => this.refreshListeners.delete(listener);
  }
  private readonly shortcutListeners = new Set<(shortcut: WorkbenchShortcut) => void>();
  private readonly revealListeners = new Set<(pluginId: string, viewId: string) => void>();
  private readonly openViewListeners = new Set<(pluginId: string, connectionId: string | undefined, request: OpenViewRequest) => void>();

  /** A view asked to open another view of its plugin in a new tab (`ViewHostApi.openView`). */
  onOpenView(listener: (pluginId: string, connectionId: string | undefined, request: OpenViewRequest) => void): () => void {
    this.openViewListeners.add(listener);
    return () => this.openViewListeners.delete(listener);
  }

  /** A view asked to show another view of its plugin (`ViewHostApi.revealView`). */
  onReveal(listener: (pluginId: string, viewId: string) => void): () => void {
    this.revealListeners.add(listener);
    return () => this.revealListeners.delete(listener);
  }

  onShortcut(listener: (shortcut: WorkbenchShortcut) => void): () => void {
    this.shortcutListeners.add(listener);
    return () => this.shortcutListeners.delete(listener);
  }

  /** The webContents of an open view instance (Edit menu commands, forwarded keys). */
  webContentsOf(instanceId: string): Electron.WebContents | undefined {
    const wc = this.instances.get(instanceId)?.view.webContents;
    return wc && !wc.isDestroyed() ? wc : undefined;
  }

  focus(instanceId: string): void {
    const wc = this.instances.get(instanceId)?.view.webContents;
    if (wc && !wc.isDestroyed()) wc.focus();
  }

  /** A view reported unsaved changes via `ViewHostApi.setDirty`. */
  onDirtyChanged(listener: (instanceId: string, dirty: boolean) => void): () => void {
    this.dirtyListeners.add(listener);
    return () => this.dirtyListeners.delete(listener);
  }

  open(opts: {
    instanceId: string;
    pluginId: string;
    viewId: string;
    connectionId?: string;
    params?: Record<string, string>;
    /** A plugin view: its page inside the plugin's ui bundle. */
    entryDir?: string;
    entryFile?: string;
    /** A core view: the page's URL (core's renderer build or dev server). */
    url?: string;
  }): void {
    if (this.instances.has(opts.instanceId)) return;

    const view = new WebContentsView({
      webPreferences: {
        preload: this.viewPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

    if (!opts.url && !(opts.entryDir && opts.entryFile)) throw new Error(`View "${opts.viewId}" has no page.`);
    const url = new URL(opts.url ?? pathToFileURL(join(opts.entryDir!, opts.entryFile!)).href);
    for (const [key, value] of Object.entries(opts.params ?? {})) {
      if (typeof value === "string") url.searchParams.set(key, value);
    }
    // Set last so a plugin-supplied param can never spoof which connection this view belongs to.
    if (opts.connectionId) url.searchParams.set("connectionId", opts.connectionId);
    else url.searchParams.delete("connectionId");

    // A focused view gets every key press, so workbench shortcuts would be dead while it has focus.
    // Catch them before the page sees them and hand them to the app shell instead.
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const mod = input.control || input.meta;
      let shortcut: WorkbenchShortcut | null = null;
      if (mod && !input.shift && !input.alt && (input.key === "`" || input.code === "Backquote")) shortcut = "togglePanel";
      else if (mod && input.shift && input.key.toLowerCase() === "p") shortcut = "commandPalette";
      else if (mod && !input.shift && !input.alt && input.key.toLowerCase() === "p") shortcut = "quickSearch";
      else if (mod && input.shift && !input.alt && input.key.toLowerCase() === "f") shortcut = "findInFiles";
      else if (mod && input.shift && !input.alt && input.key.toLowerCase() === "e") shortcut = "showExplorer";
      else if (mod && input.shift && !input.alt && input.key.toLowerCase() === "g") shortcut = "showScm";
      else if (mod && input.shift && !input.alt && input.key.toLowerCase() === "b") shortcut = "runBuildTask";
      else if (mod && !input.shift && !input.alt && input.key.toLowerCase() === "b") shortcut = "toggleSidebar";
      else if (mod && !input.shift && !input.alt && input.key.toLowerCase() === "w") shortcut = "closeEditor";
      else if (mod && !input.alt && input.key === "PageDown") shortcut = "nextEditor";
      else if (mod && !input.alt && input.key === "PageUp") shortcut = "previousEditor";
      else if (mod && !input.alt && (input.key === "=" || input.key === "+")) shortcut = "zoomIn";
      else if (mod && !input.alt && input.key === "-") shortcut = "zoomOut";
      else if (mod && !input.alt && input.key === "0") shortcut = "zoomReset";
      else if (!mod && !input.alt && input.key === "F11") shortcut = "toggleFullScreen";
      if (!shortcut) return;
      event.preventDefault();
      for (const listener of this.shortcutListeners) listener(shortcut);
    });

    view.webContents.on("did-fail-load", (_e, code, desc) => {
      console.error(`[view:${opts.instanceId}] did-fail-load`, code, desc, url.href);
    });
    view.webContents.on("console-message", (_e, _level, message) => {
      console.log(`[view:${opts.instanceId}:console]`, message);
    });
    view.webContents.on("preload-error", (_e, preloadPath, error) => {
      console.error(`[view:${opts.instanceId}] preload-error`, preloadPath, error);
    });

    view.webContents.on("did-finish-load", () => {
      if (this.zoomLevel !== 0) view.webContents.setZoomLevel(this.zoomLevel);
    });
    void view.webContents.loadURL(url.href);

    this.instances.set(opts.instanceId, {
      instanceId: opts.instanceId,
      pluginId: opts.pluginId,
      viewId: opts.viewId,
      connectionId: opts.connectionId,
      view,
    });
  }

  setBounds(instanceId: string, bounds: ViewBounds): void {
    const instance = this.instances.get(instanceId);
    if (!instance || instance.view.webContents.isDestroyed()) return;
    // The shell measures in CSS pixels; when it's zoomed those differ from the window's DIPs.
    const z = this.window.webContents.getZoomFactor();
    instance.view.setBounds(
      z === 1 ? bounds : { x: Math.round(bounds.x * z), y: Math.round(bounds.y * z), width: Math.round(bounds.width * z), height: Math.round(bounds.height * z) },
    );
  }

  private zoomLevel = 0;
  /** View > Zoom: views follow the shell's zoom level (new ones too). */
  setZoomLevel(level: number): void {
    this.zoomLevel = level;
    for (const instance of this.instances.values()) if (!instance.view.webContents.isDestroyed()) instance.view.webContents.setZoomLevel(level);
  }

  /** Theme changed: every view's preload re-applies the colors (and icon cache version). */
  broadcastTheme(state: unknown): void {
    for (const instance of this.instances.values()) {
      if (!instance.view.webContents.isDestroyed()) instance.view.webContents.send("oneclient-view:theme", state);
    }
  }

  /** Push a message to every open instance of `viewId` scoped to `connectionId` (normally exactly one). */
  push(viewId: string, connectionId: string | undefined, message: unknown): void {
    for (const instance of this.instances.values()) {
      if (instance.viewId === viewId && instance.connectionId === connectionId) {
        if (!instance.view.webContents.isDestroyed()) instance.view.webContents.send("oneclient-view:push", message);
      }
    }
  }

  close(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    this.instances.delete(instanceId);
    // On quit the window (and with it the views) is often already destroyed by the time
    // before-quit cleanup runs — touching it then throws "Object has been destroyed".
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(instance.view);
    if (!instance.view.webContents.isDestroyed()) instance.view.webContents.close();
  }

  closeAll(): void {
    for (const id of [...this.instances.keys()]) this.close(id);
  }

  getInstance(instanceId: string): { pluginId: string; viewId: string; connectionId?: string } | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance) return undefined;
    return { pluginId: instance.pluginId, viewId: instance.viewId, connectionId: instance.connectionId };
  }
}
