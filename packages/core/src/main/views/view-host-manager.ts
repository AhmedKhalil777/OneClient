import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type BrowserWindow, WebContentsView, ipcMain } from "electron";

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
    ipcMain.on("oneclient-view:dirty", (event, dirty: unknown) => {
      const instance = [...this.instances.values()].find((i) => i.view.webContents === event.sender);
      if (instance) for (const listener of this.dirtyListeners) listener(instance.instanceId, dirty === true);
    });
  }

  private readonly dirtyListeners = new Set<(instanceId: string, dirty: boolean) => void>();

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
    entryDir: string;
    entryFile: string;
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

    const entryPath = join(opts.entryDir, opts.entryFile);
    const url = new URL(pathToFileURL(entryPath).href);
    for (const [key, value] of Object.entries(opts.params ?? {})) {
      if (typeof value === "string") url.searchParams.set(key, value);
    }
    // Set last so a plugin-supplied param can never spoof which connection this view belongs to.
    if (opts.connectionId) url.searchParams.set("connectionId", opts.connectionId);
    else url.searchParams.delete("connectionId");

    view.webContents.on("did-fail-load", (_e, code, desc) => {
      console.error(`[view:${opts.instanceId}] did-fail-load`, code, desc, url.href);
    });
    view.webContents.on("console-message", (_e, _level, message) => {
      console.log(`[view:${opts.instanceId}:console]`, message);
    });
    view.webContents.on("preload-error", (_e, preloadPath, error) => {
      console.error(`[view:${opts.instanceId}] preload-error`, preloadPath, error);
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
    this.instances.get(instanceId)?.view.setBounds(bounds);
  }

  /** Push a message to every open instance of `viewId` scoped to `connectionId` (normally exactly one). */
  push(viewId: string, connectionId: string | undefined, message: unknown): void {
    for (const instance of this.instances.values()) {
      if (instance.viewId === viewId && instance.connectionId === connectionId) {
        instance.view.webContents.send("oneclient-view:push", message);
      }
    }
  }

  close(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    this.window.contentView.removeChildView(instance.view);
    instance.view.webContents.close();
    this.instances.delete(instanceId);
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
