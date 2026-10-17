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
  /** Drives `when` clauses for context-menu commands (see manifest contributes.commands). */
  readonly contextValue?: string;
  readonly collapsible: "none" | "collapsed" | "expanded";
  readonly connectionId?: string;
  readonly data?: unknown;
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
