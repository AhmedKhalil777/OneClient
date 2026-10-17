import type { Logger } from "./logging.js";
import type { SecretStore } from "./secrets.js";

export interface ExplorerContext {
  readonly logger: Logger;
  readonly secrets: SecretStore;
  readonly signal: AbortSignal;
  /** Which saved connection this tree belongs to. Scope any internal session/handle cache by this. */
  readonly connectionId: string;
}

/**
 * One node in the sidebar explorer tree. Core owns the tree widget and
 * rendering (icons, expand/collapse, context menus); plugins only ever
 * hand back plain `TreeNode` data from `getChildren`.
 *
 * `data` is an opaque payload the provider attaches to its own nodes and
 * receives back unchanged when core asks for that node's children — e.g. a
 * postgres provider stashes `{ schema: "public" }` on a schema node so the
 * next `getChildren` call knows which schema to list tables for.
 */
export interface TreeNode {
  readonly id: string;
  readonly label: string;
  /** Must match one of the provider's `nodeTypes`, and a `contributes.explorerNodes[].id` in the manifest. */
  readonly nodeType: string;
  readonly icon?: string;
  /**
   * Marks this node as a file or folder so core picks its icon from the active
   * icon theme's file associations (by name, then extension — like VS Code's
   * file icon themes). `icon` is the fallback when the theme has no mapping,
   * so set both (e.g. `icon: "$(file)"`).
   */
  readonly resource?: { readonly name: string; readonly kind: "file" | "folder" };
  /** Drives `when` clauses for context-menu commands (see manifest contributes.commands). */
  readonly contextValue?: string;
  readonly collapsible: "none" | "collapsed" | "expanded";
  readonly connectionId?: string;
  readonly data?: unknown;
  /**
   * Clicking this node opens a Tier 2 view (from this plugin's
   * `contributes.views`) in its own editor tab — e.g. a file node opening
   * an editor. One tab per node: clicking it again re-focuses that tab.
   */
  readonly openView?: TreeNodeOpenView;
}

export interface TreeNodeOpenView {
  /** A `contributes.views[].id` with `tier: 2` from the same plugin. */
  readonly viewId: string;
  /** Tab title; defaults to the node's label. */
  readonly title?: string;
  /** Tab icon as a `$(id)` registry icon (nodes with a `resource` get their file icon instead). */
  readonly icon?: string;
  /**
   * Handed to the view as URL query parameters (alongside `connectionId`),
   * readable via `new URLSearchParams(location.search)`.
   */
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * Supplies children for one or more node types under a connection.
 * Registered via `PluginContext.registerExplorerProvider`. Core calls
 * `getChildren(null, ...)` to get the root node(s) for a connection, then
 * calls it again with that node to lazily expand — nothing is pre-fetched.
 */
export interface ExplorerProvider {
  /** Node types this provider can produce children for. */
  readonly nodeTypes: string[];

  /**
   * @param node `null` when fetching the root node(s) for a connection
   *   (e.g. the connection's own top-level node); otherwise the node
   *   being expanded.
   */
  getChildren(node: TreeNode | null, context: ExplorerContext): Promise<TreeNode[]>;
}
