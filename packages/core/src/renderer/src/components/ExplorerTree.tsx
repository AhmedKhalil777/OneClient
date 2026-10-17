import { useEffect, useState } from "react";
import type { TreeNode } from "@oneclient/plugin-api";

interface Props {
  connectionId: string;
  node: TreeNode;
  depth: number;
}

/** One lazily-expandable node. Root nodes are rendered by ConnectionRow, which owns depth 0. */
export function ExplorerTreeNode({ connectionId, node, depth }: Props) {
  const [expanded, setExpanded] = useState(node.collapsible === "expanded");
  const [children, setChildren] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canExpand = node.collapsible !== "none";

  async function toggle() {
    if (!canExpand) return;
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      try {
        const kids = await window.oneclient.getExplorerChildren(connectionId, node);
        setChildren(kids);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return (
    <div>
      <div className="tree-row" style={{ paddingLeft: 12 + depth * 14 }} onClick={toggle}>
        <span className="tree-caret">{canExpand ? (expanded ? "▾" : "▸") : ""}</span>
        <span>{node.label}</span>
      </div>
      {expanded && error && (
        <div className="tree-row tree-row-error" style={{ paddingLeft: 12 + (depth + 1) * 14 }}>
          {error}
        </div>
      )}
      {expanded &&
        children?.map((child) => (
          <ExplorerTreeNode key={child.id} connectionId={connectionId} node={child} depth={depth + 1} />
        ))}
    </div>
  );
}

export function ConnectionRootNodes({ connectionId }: { connectionId: string }) {
  const [children, setChildren] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.oneclient
      .getExplorerChildren(connectionId, null)
      .then((kids) => {
        if (!cancelled) setChildren(kids);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  if (error) return <div className="tree-row tree-row-error">{error}</div>;
  if (children === null) return <div className="empty-hint">Loading…</div>;
  if (children.length === 0) return <div className="empty-hint">No items.</div>;

  return (
    <>
      {children.map((node) => (
        <ExplorerTreeNode key={node.id} connectionId={connectionId} node={node} depth={0} />
      ))}
    </>
  );
}
