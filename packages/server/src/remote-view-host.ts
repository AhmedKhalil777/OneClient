import { relative } from "node:path";
import type { OpenViewRequest } from "@oneclient/plugin-api";
import type { WorkbenchShortcut } from "@oneclient/backend/shared/ipc-contract.js";
import { PLUGIN_UI_PREFIX, type ViewEventKind } from "@oneclient/backend/shared/web-protocol.js";
import type { MessageFromViewFn, OpenFileHandler, OpenViewOptions, ViewHost, ViewInstanceInfo } from "@oneclient/backend/views/view-host.js";
import type { RpcHost } from "@oneclient/backend/rpc/rpc-host.js";
import type { WebClient, WsRpc } from "./ws-rpc.js";

interface Instance extends ViewInstanceInfo {
  instanceId: string;
  client: WebClient;
}

/**
 * Tier 2 views in the web runtime: each instance is an iframe in the browser tab that opened it (the bridge mounts it).
 * The server keeps which tab owns which instance — keyed per tab, since every tab numbers its instances alike — routes
 * plugins' pushes to it, and turns what the view sends into the same events as the desktop's ViewHostManager.
 */
export class RemoteViewHost implements ViewHost {
  private readonly instances = new Map<string, Instance>();
  private openFileHandler: OpenFileHandler | undefined;
  private readonly dirty = new Set<(instanceId: string, dirty: boolean) => void>();
  private readonly shortcuts = new Set<(shortcut: WorkbenchShortcut) => void>();
  private readonly reveals = new Set<(pluginId: string, viewId: string) => void>();
  private readonly refreshes = new Set<(connectionId: string) => void>();
  private readonly openViews = new Set<(pluginId: string, connectionId: string | undefined, request: OpenViewRequest) => void>();
  private readonly closed = new Set<(instance: ViewInstanceInfo) => void>();

  constructor(
    rpc: WsRpc & RpcHost,
    private readonly onMessageFromView: MessageFromViewFn,
  ) {
    rpc.setViewEventHandler((client, instanceId, kind, payload) => this.fromView(client, instanceId, kind, payload));
    // The tab closed or reloaded: its views are gone.
    rpc.onDisconnect((client) => {
      for (const instance of [...this.instances.values()]) if (instance.client === client) this.remove(instance);
    });
    rpc.handle("oneclient-view:open-file", async (_caller, path: unknown, options: unknown) => {
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
  }

  private key(client: WebClient, instanceId: string): string {
    return `${client.id}/${instanceId}`;
  }

  /** Registers the instance for `caller`'s tab and returns the page its iframe loads. */
  open(opts: OpenViewOptions, caller: unknown): { url: string } {
    const client = caller as WebClient;
    // Arguments crossed the socket as JSON, where a missing connection arrives as null; views match pushes on it.
    opts = { ...opts, connectionId: opts.connectionId || undefined, params: opts.params ?? undefined };
    let path: string;
    if (opts.corePage) path = `/${opts.corePage}`;
    else if (opts.entryDir && opts.entryFile) path = `${PLUGIN_UI_PREFIX}${encodeURIComponent(opts.pluginId)}/${relative(opts.entryDir, `${opts.entryDir}/${opts.entryFile}`).replace(/\\/g, "/")}`;
    else throw new Error(`View "${opts.viewId}" has no page.`);
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.params ?? {})) if (typeof v === "string") query.set(k, v);
    // Set last so a plugin-supplied param can never spoof which connection this view belongs to.
    if (opts.connectionId) query.set("connectionId", opts.connectionId);
    else query.delete("connectionId");
    this.instances.set(this.key(client, opts.instanceId), { instanceId: opts.instanceId, pluginId: opts.pluginId, viewId: opts.viewId, connectionId: opts.connectionId, client });
    const qs = query.toString();
    return { url: qs ? `${path}?${qs}` : path };
  }

  private fromView(client: WebClient, instanceId: string, kind: ViewEventKind, payload: unknown): void {
    // pluginId/connectionId come from server-side state, never from the page.
    const instance = this.instances.get(this.key(client, instanceId));
    if (!instance) return;
    switch (kind) {
      case "post":
        this.onMessageFromView(instance.pluginId, instance.viewId, instance.connectionId, payload);
        return;
      case "dirty":
        for (const l of this.dirty) l(instanceId, payload === true);
        return;
      case "reveal":
        if (typeof payload === "string") for (const l of this.reveals) l(instance.pluginId, payload);
        return;
      case "refresh-explorer":
        if (instance.connectionId) for (const l of this.refreshes) l(instance.connectionId);
        return;
      case "open-view": {
        const r = payload as Partial<OpenViewRequest> | null;
        if (!r || typeof r.viewId !== "string" || typeof r.title !== "string") return;
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(r.params ?? {})) if (typeof v === "string") params[k] = v;
        const clean: OpenViewRequest = { viewId: r.viewId, title: r.title, params, ...(typeof r.icon === "string" ? { icon: r.icon } : {}) };
        for (const l of this.openViews) l(instance.pluginId, instance.connectionId, clean);
        return;
      }
    }
  }

  private remove(instance: Instance): void {
    this.instances.delete(this.key(instance.client, instance.instanceId));
    for (const l of this.closed) l({ pluginId: instance.pluginId, viewId: instance.viewId, connectionId: instance.connectionId });
  }

  close(instanceId: string, caller?: unknown): void {
    const instance = caller ? this.instances.get(this.key(caller as WebClient, instanceId)) : undefined;
    if (instance) this.remove(instance);
  }

  closeAll(): void {
    for (const instance of [...this.instances.values()]) this.remove(instance);
  }

  getInstance(instanceId: string, caller?: unknown): ViewInstanceInfo | undefined {
    const instance = caller ? this.instances.get(this.key(caller as WebClient, instanceId)) : undefined;
    return instance && { pluginId: instance.pluginId, viewId: instance.viewId, connectionId: instance.connectionId };
  }

  hasInstance(viewId: string): boolean {
    return [...this.instances.values()].some((i) => i.viewId === viewId);
  }

  push(viewId: string, connectionId: string | undefined, message: unknown): void {
    for (const instance of this.instances.values()) {
      if (instance.viewId === viewId && instance.connectionId === connectionId) instance.client.send({ t: "view", inst: instance.instanceId, payload: message });
    }
  }

  /** The bridge applies the shell's theme to its iframes itself (it gets every theme change already). */
  broadcastTheme(): void {}

  setOpenFileHandler(handler: OpenFileHandler): void {
    this.openFileHandler = handler;
  }
  onDirtyChanged(listener: (instanceId: string, dirty: boolean) => void): () => void {
    this.dirty.add(listener);
    return () => this.dirty.delete(listener);
  }
  onShortcut(listener: (shortcut: WorkbenchShortcut) => void): () => void {
    // In the browser the bridge catches shortcuts inside iframes itself; nothing comes from the server.
    this.shortcuts.add(listener);
    return () => this.shortcuts.delete(listener);
  }
  onReveal(listener: (pluginId: string, viewId: string) => void): () => void {
    this.reveals.add(listener);
    return () => this.reveals.delete(listener);
  }
  onRefreshExplorer(listener: (connectionId: string) => void): () => void {
    this.refreshes.add(listener);
    return () => this.refreshes.delete(listener);
  }
  onOpenView(listener: (pluginId: string, connectionId: string | undefined, request: OpenViewRequest) => void): () => void {
    this.openViews.add(listener);
    return () => this.openViews.delete(listener);
  }
  onInstanceClosed(listener: (instance: ViewInstanceInfo) => void): () => void {
    this.closed.add(listener);
    return () => this.closed.delete(listener);
  }
}
