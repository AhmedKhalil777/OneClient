import { useState } from "react";
import type { ViewContribution } from "@oneclient/plugin-api";
import type { ConnectionSummary, PluginSummary } from "../../../shared/types.js";
import { ConnectionRootNodes } from "./ExplorerTree.js";

type DashboardView = ViewContribution & { pluginId: string };

export function Sidebar({
  connections,
  plugins,
  views,
  onNewConnection,
  onOpenPluginManager,
  onOpenDashboard,
}: {
  connections: ConnectionSummary[];
  plugins: PluginSummary[];
  views: DashboardView[];
  onNewConnection: () => void;
  onOpenPluginManager: () => void;
  onOpenDashboard: (connection: ConnectionSummary, view: DashboardView) => void;
}) {
  return (
    <div className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-section-title">
          <span>CONNECTIONS</span>
          <button className="icon-button" title="New Connection" onClick={onNewConnection}>
            +
          </button>
        </div>
        {connections.length === 0 && <div className="empty-hint">No connections yet.</div>}
        {connections.map((c) => {
          const dashboard = views.find((v) => v.tier === 2 && v.connectionType === c.typeId);
          return (
            <ConnectionRow
              key={c.id}
              connection={c}
              dashboard={dashboard}
              onOpenDashboard={dashboard ? () => onOpenDashboard(c, dashboard) : undefined}
            />
          );
        })}
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title" onClick={onOpenPluginManager} style={{ cursor: "pointer" }}>
          <span>PLUGINS ({plugins.length})</span>
        </div>
        {plugins.map((p) => (
          <div className="tree-row" key={p.id} onClick={onOpenPluginManager}>
            <span>{p.displayName ?? p.id}</span>
            <span className={`badge badge-${p.state}`}>{p.state}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectionRow({
  connection,
  dashboard,
  onOpenDashboard,
}: {
  connection: ConnectionSummary;
  dashboard?: DashboardView;
  onOpenDashboard?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function remove(e: React.MouseEvent) {
    e.stopPropagation();
    setDeleting(true);
    try {
      await window.oneclient.deleteConnection(connection.id);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="tree-row" onClick={() => setExpanded((v) => !v)}>
        <span className="tree-caret">{expanded ? "▾" : "▸"}</span>
        <span>{connection.name}</span>
        <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 11 }}>{connection.typeId}</span>
        {onOpenDashboard && (
          <button
            className="icon-button"
            title={`Open ${dashboard?.title ?? "Dashboard"}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpenDashboard();
            }}
          >
            ⊞
          </button>
        )}
        <button className="icon-button" title="Delete" disabled={deleting} onClick={remove}>
          ×
        </button>
      </div>
      {expanded && <ConnectionRootNodes connectionId={connection.id} />}
    </div>
  );
}
