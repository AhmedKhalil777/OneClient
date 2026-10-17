import { useCallback, useEffect, useState } from "react";
import type { TreeNode } from "@oneclient/plugin-api";
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
}

/** One lazily-expandable node. Root nodes are rendered by ConnectionRootNodes. */
export function ExplorerTreeNode({ connectionId, pluginId, node, depth, onOpenView, onContextMenu, reloadParent }: Props) {
  const [expanded, setExpanded] = useState(node.collapsible === "expanded");
  const [children, setChildren] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canExpand = node.collapsible !== "none";

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
        title={node.label}
      >
        <span className="tree-caret">{canExpand ? (expanded ? "▾" : "▸") : ""}</span>
        <AssetIcon pluginId={pluginId} icon={node.icon} size={14} fallback={canExpand ? "📁" : "•"} />
        <span className="tree-label">{node.label}</span>
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
  onOpenView,
  onContextMenu,
}: {
  connectionId: string;
  pluginId: string;
  version: number;
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
  }, [connectionId, version, localVersion]);

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
        />
      ))}
    </>
  );
}
