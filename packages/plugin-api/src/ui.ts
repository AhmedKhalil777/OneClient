import type { ThemeState } from "./theme.js";

/**
 * Tier 1: declarative result grids.
 *
 * A command handler (e.g. "Run Query") returns a `TableResult` instead of
 * JSX; core's generic grid component renders it. This keeps result-set
 * rendering (sorting, paging, cell formatting, CSV export) as shared core
 * code rather than something every plugin reimplements.
 */
export type ColumnValueType = "string" | "number" | "boolean" | "date" | "json" | "null";

export interface ColumnDescriptor {
  readonly key: string;
  readonly label: string;
  readonly type?: ColumnValueType;
  readonly sortable?: boolean;
  readonly width?: number;
}

export interface TableResult {
  readonly columns: ColumnDescriptor[];
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** Present when the provider truncated results; drives a "Load more" affordance. */
  readonly truncated?: boolean;
  readonly totalRowCount?: number;
}

/**
 * Tier 2: custom view host contract.
 *
 * A manifest view with `tier: 2` points `entry` at a small HTML/JS bundle.
 * Core loads that bundle into an isolated surface (contextIsolation on,
 * nodeIntegration off, strict CSP — see ARCHITECTURE.md § Tier 2 views for
 * why this is a WebContentsView/hidden BrowserWindow rather than the
 * legacy `<webview>` tag) and injects a `ViewHostApi` into its preload.
 * The plugin's view-side JS only ever talks to this facade — never to
 * ipcRenderer/Node directly.
 *
 * On the plugin's backend side (running in its extension host), the
 * matching half is `PluginContext.registerView(viewId, handler)`, which
 * receives messages posted via `ViewHostApi.postMessage` and can push
 * messages back via `onMessage`.
 */
export interface ViewHostApi {
  /** Send a message from the view to this view's registered backend handler. */
  postMessage(message: unknown): void;
  /** Subscribe to messages pushed from the backend handler. Returns an unsubscribe function. */
  onMessage(listener: (message: unknown) => void): () => void;
  /** Invoke a contributed command by id, same as the command palette would. */
  invokeCommand(commandId: string, args?: unknown[]): Promise<unknown>;
  /**
   * Mark this view instance as having unsaved changes (or not). Core shows
   * a ● on its tab and asks before closing a dirty tab.
   */
  setDirty(dirty: boolean): void;
  /**
   * Show another view of the same plugin — e.g. a query editor revealing
   * its "Query Results" view in the bottom panel after running.
   */
  revealView(viewId: string): void;
  /**
   * The active color/icon theme. Its colors are also applied to the view's
   * document as `--oc-*` CSS variables automatically — this is for code that
   * needs values in JS (e.g. a canvas or xterm.js). Null until loaded.
   */
  getTheme(): ThemeState | null;
  /** Called with the new state whenever the user switches theme (and once when it first loads). */
  onThemeChange(listener: (theme: ThemeState) => void): () => void;
  /**
   * Contributions other plugins made to an extension point (`contributes.extensions[point]`),
   * each tagged with the contributing `pluginId`. Read at load; plugins enabled later appear on next open.
   */
  getContributions(point: string): Promise<Array<Record<string, unknown> & { pluginId: string }>>;
  /** Open an http(s)/mailto URL in the user's browser/mail client. Other schemes are ignored. */
  openExternal(url: string): void;
}

/**
 * One registered handler (`registerView(viewId, handler)`) serves every
 * open instance of that view — e.g. a user can open a per-connection
 * dashboard for two different connections at once, both backed by the
 * same handler. `connectionId` tells you which instance a message came
 * from (present when the view's manifest contribution sets
 * `connectionType`; absent for connection-agnostic views).
 *
 * `reply` stays valid for the life of the view instance and can be called
 * any number of times — including asynchronously, well after `onMessage`
 * returns — which is what makes pushing a live log tail or periodic
 * status refresh to the view work: keep the `reply` from the view's
 * initial "subscribe" message and call it whenever new data is ready.
 */
export interface ViewMessageContext {
  readonly connectionId?: string;
  reply(message: unknown): void;
}

export interface ViewMessageHandler {
  onMessage(message: unknown, context: ViewMessageContext): void | Promise<void>;
  /** Called when this specific view instance is closed/torn down; release any resources (e.g. a log-tail subscription) held for it. */
  onDispose?(connectionId?: string): void | Promise<void>;
}
