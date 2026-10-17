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
}

export interface ViewMessageHandler {
  onMessage(message: unknown, reply: (message: unknown) => void): void | Promise<void>;
  /** Called when the view is closed/torn down; release any resources here. */
  onDispose?(): void | Promise<void>;
}
