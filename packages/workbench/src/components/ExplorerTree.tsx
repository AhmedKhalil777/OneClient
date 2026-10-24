import { useCallback, useEffect, useRef, useState } from "react";
import type { TreeNode } from "@oneclient/plugin-api";
import { ThemeIcon, useResourceIcon } from "../theme.js";
import { AssetIcon } from "./AssetIcon.js";

/** Called when a node with `openView` is clicked. */
export type OpenNodeViewFn = (node: TreeNode) => void;

/**
 * Right-click on a node. `refresh` re-lists that node's children (expanding
 * it) and its parent's — what a command that created, renamed or deleted
 * something under/as this node needs afterwards.
 */
export type NodeContextMenuFn = (e: React.MouseEvent, node: TreeNode, refresh: () => void) => void;

interface Props {
  connectionId: string;
  pluginId: string;
  node: TreeNode;
  depth: number;
  onOpenView: OpenNodeViewFn;
  onContextMenu: NodeContextMenuFn;
  reloadParent: () => void;
  /**
   * Bump to re-fetch the children of every expanded node in this subtree in place — expansion is kept (unlike a
   * remount). Used when a plugin asks for its tree to be refreshed (`refreshExplorer()`).
   */
  refreshToken?: number;
}

/** One lazily-expandable node. Root nodes are rendered by ConnectionRootNodes. */
export function ExplorerTreeNode({ connectionId, pluginId, node, depth, onOpenView, onContextMenu, reloadParent, refreshToken = 0 }: Props) {
  const [expanded, setExpanded] = useState(node.collapsible === "expanded");
  const [children, setChildren] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canExpand = node.collapsible !== "none";
  // File/folder nodes take their icon from the icon theme's file associations (open folders get their open variant).
  const resourceIcon = useResourceIcon(node.resource, expanded);

  const loadChildren = useCallback(async () => {
    try {
      setChildren(await window.oneclient.getExplorerChildren(connectionId, node));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // node identity changes on every parent reload; its id is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, node.id, node.nodeType]);

  useEffect(() => {
    if (expanded && children === null) void loadChildren();
  }, [expanded, children, loadChildren]);

  const seenToken = useRef(refreshToken);
  useEffect(() => {
    if (seenToken.current === refreshToken) return;
    seenToken.current = refreshToken;
    // Collapsed nodes just drop their cached children; they reload when next expanded.
    if (expanded) void loadChildren();
    else setChildren(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  function onClick() {
    if (node.openView) onOpenView(node);
    if (canExpand) setExpanded((v) => !v);
  }

  function refresh() {
    if (canExpand) {
      setExpanded(true);
      void loadChildren();
    }
    reloadParent();
  }

  return (
    <div>
      <div
        className="tree-row"
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e, node, refresh);
        }}
        title={node.tooltip ?? (node.description ? `${node.label} — ${node.description}` : node.label)}
      >
        <span className="tree-caret">{canExpand && <ThemeIcon id={expanded ? "chevron-down" : "chevron-right"} />}</span>
        <AssetIcon pluginId={pluginId} icon={resourceIcon ?? node.icon} size={14} fallback={canExpand ? "📁" : "•"} />
        <span className="tree-label">{node.label}</span>
        {node.description && <span className="tree-description">{node.description}</span>}
      </div>
      {expanded && error && (
        <div className="tree-row tree-row-error" style={{ paddingLeft: 12 + (depth + 1) * 14 }}>
          {error}
        </div>
      )}
      {expanded &&
        children?.map((child) => (
          <ExplorerTreeNode
            key={child.id}
            connectionId={connectionId}
            pluginId={pluginId}
            node={child}
            depth={depth + 1}
            onOpenView={onOpenView}
            onContextMenu={onContextMenu}
            reloadParent={() => void loadChildren()}
            refreshToken={refreshToken}
          />
        ))}
    </div>
  );
}

/** The top-level nodes under one connection. Bump `version` to re-fetch them. */
export function ConnectionRootNodes({
  connectionId,
  pluginId,
  version,
  refreshToken = 0,
  onOpenView,
  onContextMenu,
}: {
  connectionId: string;
  pluginId: string;
  version: number;
  /** See ExplorerTreeNode — re-fetches the roots and every expanded node, keeping expansion. */
  refreshToken?: number;
  onOpenView: OpenNodeViewFn;
  onContextMenu: NodeContextMenuFn;
}) {
  const [children, setChildren] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localVersion, setLocalVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    window.oneclient
      .getExplorerChildren(connectionId, null)
      .then((kids) => {
        if (cancelled) return;
        setChildren(kids);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, version, localVersion, refreshToken]);

  if (error) return <div className="tree-row tree-row-error">{error}</div>;
  if (children === null) return <div className="empty-hint">Loading…</div>;
  if (children.length === 0) return <div className="empty-hint">No items.</div>;

  return (
    <>
      {children.map((node) => (
        <ExplorerTreeNode
          key={node.id}
          connectionId={connectionId}
          pluginId={pluginId}
          node={node}
          depth={1}
          onOpenView={onOpenView}
          onContextMenu={onContextMenu}
          reloadParent={() => setLocalVersion((v) => v + 1)}
          refreshToken={refreshToken}
        />
      ))}
    </>
  );
}
