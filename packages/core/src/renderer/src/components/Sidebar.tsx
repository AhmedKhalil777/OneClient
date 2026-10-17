import { useState } from "react";
import type { CommandContribution, ConnectionTypeContribution, TreeNode, ViewContribution } from "@oneclient/plugin-api";
import type { ConnectionSummary, PluginSummary } from "../../../shared/types.js";
import type { ViewContainerId } from "./ActivityBar.js";
import { ThemeIcon } from "../theme.js";
import { AssetIcon } from "./AssetIcon.js";
import { ConnectionRootNodes, type NodeContextMenuFn, type OpenNodeViewFn } from "./ExplorerTree.js";

/** Right-click on a connection row (`node` undefined) or a tree node under it. */
export type ExplorerContextMenuFn = (
  e: React.MouseEvent,
  connection: ConnectionSummary,
  node: TreeNode | undefined,
  refresh: () => void,
) => void;

type DashboardView = ViewContribution & { pluginId: string };
type ConnectionType = ConnectionTypeContribution & { pluginId: string };
type Command = CommandContribution & { pluginId: string };

/**
 * The sidebar shows exactly one view container, picked in the activity bar:
 * either one plugin's explorer (split into collapsible sections, VS Code
 * style) or the built-in Plugins list.
 */
export function Sidebar({
  container,
  connections,
  plugins,
  views,
  connectionTypes,
  commands,
  onNewConnection,
  onRunCommand,
  onOpenPluginManager,
  onOpenDashboard,
  onOpenNodeView,
  onExplorerContextMenu,
}: {
  container: ViewContainerId;
  connections: ConnectionSummary[];
  plugins: PluginSummary[];
  views: DashboardView[];
  connectionTypes: ConnectionType[];
  commands: Command[];
  onNewConnection: (pluginId: string) => void;
  onRunCommand: (commandId: string, title: string) => void;
  onOpenPluginManager: () => void;
  onOpenDashboard: (connection: ConnectionSummary, view: DashboardView) => void;
  onOpenNodeView: (connection: ConnectionSummary, node: TreeNode) => void;
  onExplorerContextMenu: ExplorerContextMenuFn;
}) {
  if (container === "plugins") {
    return <PluginsContainer plugins={plugins} onOpenPluginManager={onOpenPluginManager} />;
  }

  const pluginId = container.slice("plugin:".length);
  const plugin = plugins.find((p) => p.id === pluginId);
  if (!plugin) {
    return (
      <div className="sidebar">
        <div className="empty-hint">Plugin not found.</div>
      </div>
    );
  }

  return (
    <PluginContainer
      key={plugin.id}
      plugin={plugin}
      connections={connections.filter((c) => c.pluginId === plugin.id)}
      views={views.filter((v) => v.pluginId === plugin.id)}
      connectionTypes={connectionTypes.filter((t) => t.pluginId === plugin.id)}
      commands={commands.filter((c) => c.pluginId === plugin.id && !c.when && !c.hidden)}
      onNewConnection={() => onNewConnection(plugin.id)}
      onRunCommand={onRunCommand}
      onOpenDashboard={onOpenDashboard}
      onOpenNodeView={onOpenNodeView}
      onExplorerContextMenu={onExplorerContextMenu}
    />
  );
}

function PluginContainer({
  plugin,
  connections,
  views,
  connectionTypes,
  commands,
  onNewConnection,
  onRunCommand,
  onOpenDashboard,
  onOpenNodeView,
  onExplorerContextMenu,
}: {
  plugin: PluginSummary;
  connections: ConnectionSummary[];
  views: DashboardView[];
  connectionTypes: ConnectionType[];
  commands: Command[];
  onNewConnection: () => void;
  onRunCommand: (commandId: string, title: string) => void;
  onOpenDashboard: (connection: ConnectionSummary, view: DashboardView) => void;
  onOpenNodeView: (connection: ConnectionSummary, node: TreeNode) => void;
  onExplorerContextMenu: ExplorerContextMenuFn;
}) {
  // Bumping this remounts every connection tree, re-fetching its children.
  const [refreshKey, setRefreshKey] = useState(0);
  const containerId = `plugin:${plugin.id}`;
  const canConnect = connectionTypes.length > 0 && plugin.state === "active";

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>{(plugin.displayName ?? plugin.id).toUpperCase()}</span>
        {plugin.state !== "active" && <span className={`badge badge-${plugin.state}`}>{plugin.state}</span>}
      </div>

      {plugin.error && <div className="empty-hint tree-row-error">{plugin.error}</div>}

      {connectionTypes.length > 0 && (
        <SidebarSection
          containerId={containerId}
          sectionId="connections"
          title="Connections"
          count={connections.length}
          actions={
            <>
              <button className="icon-button" title="New Connection" disabled={!canConnect} onClick={onNewConnection}>
                <ThemeIcon id="add" />
              </button>
              <button className="icon-button" title="Refresh" onClick={() => setRefreshKey((k) => k + 1)}>
                <ThemeIcon id="refresh" />
              </button>
            </>
          }
        >
          {connections.length === 0 ? (
            <div className="empty-hint">
              No connections yet.{" "}
              {canConnect && (
                <button className="link-button" onClick={onNewConnection}>
                  Add one
                </button>
              )}
            </div>
          ) : (
            connections.map((c) => {
              const dashboard = views.find((v) => v.tier === 2 && v.connectionType === c.typeId);
              const connectionType = connectionTypes.find((t) => t.id === c.typeId);
              return (
                <ConnectionRow
                  key={`${c.id}:${refreshKey}`}
                  connection={c}
                  icon={connectionType?.icon}
                  dashboard={dashboard}
                  onOpenDashboard={dashboard ? () => onOpenDashboard(c, dashboard) : undefined}
                  onOpenNodeView={(node) => onOpenNodeView(c, node)}
                  onContextMenu={(e, node, refresh) => onExplorerContextMenu(e, c, node, refresh)}
                />
              );
            })
          )}
        </SidebarSection>
      )}

      {commands.length > 0 && (
        <SidebarSection containerId={containerId} sectionId="commands" title="Commands" count={commands.length} defaultExpanded={false}>
          {commands.map((c) => (
            <div className="tree-row" key={c.id} title={c.id} onClick={() => onRunCommand(c.id, c.title)}>
              <span className="tree-caret" />
              <span>{stripCategory(c.title)}</span>
            </div>
          ))}
        </SidebarSection>
      )}
    </div>
  );
}

function PluginsContainer({ plugins, onOpenPluginManager }: { plugins: PluginSummary[]; onOpenPluginManager: () => void }) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>PLUGINS</span>
      </div>
      <SidebarSection
        containerId="plugins"
        sectionId="installed"
        title="Installed"
        count={plugins.length}
        actions={
          <button className="icon-button" title="Open Plugin Manager" onClick={onOpenPluginManager}>
            <ThemeIcon id="gear" />
          </button>
        }
      >
        {plugins.map((p) => (
          <div className="tree-row" key={p.id} onClick={onOpenPluginManager}>
            <AssetIcon pluginId={p.id} icon={p.icon} />
            <span>{p.displayName ?? p.id}</span>
            <span className={`badge badge-${p.state}`}>{p.state}</span>
          </div>
        ))}
      </SidebarSection>
    </div>
  );
}

/** A collapsible VS Code-style section; its expanded state is remembered per container. */
function SidebarSection({
  containerId,
  sectionId,
  title,
  count,
  actions,
  defaultExpanded = true,
  children,
}: {
  containerId: string;
  sectionId: string;
  title: string;
  count?: number;
  actions?: React.ReactNode;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}) {
  const storageKey = `oneclient.section.${containerId}.${sectionId}`;
  const [expanded, setExpanded] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored === null ? defaultExpanded : stored === "1";
  });

  function toggle() {
    setExpanded((v) => {
      localStorage.setItem(storageKey, v ? "0" : "1");
      return !v;
    });
  }

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-title" onClick={toggle}>
        <span className="tree-caret"><ThemeIcon id={expanded ? "chevron-down" : "chevron-right"} /></span>
        <span>{title.toUpperCase()}</span>
        {count !== undefined && <span className="section-count">{count}</span>}
        {actions && (
          <span className="section-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </div>
      {expanded && <div className="sidebar-section-body">{children}</div>}
    </div>
  );
}

/** "Docker: List Containers" → "List Containers" — the container header already names the plugin. */
export function stripCategory(title: string): string {
  const i = title.indexOf(": ");
  return i === -1 ? title : title.slice(i + 2);
}

function ConnectionRow({
  connection,
  icon,
  dashboard,
  onOpenDashboard,
  onOpenNodeView,
  onContextMenu,
}: {
  connection: ConnectionSummary;
  icon?: string;
  dashboard?: DashboardView;
  onOpenDashboard?: () => void;
  onOpenNodeView: OpenNodeViewFn;
  /** `node` undefined = the connection row itself. */
  onContextMenu: (e: React.MouseEvent, node: TreeNode | undefined, refresh: () => void) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [rootVersion, setRootVersion] = useState(0);

  const refreshRoot = () => {
    setExpanded(true);
    setRootVersion((v) => v + 1);
  };
  const onNodeContextMenu: NodeContextMenuFn = (e, node, refresh) => onContextMenu(e, node, refresh);

  return (
    <div>
      <div
        className="tree-row connection-row"
        onClick={() => setExpanded((v) => !v)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, undefined, refreshRoot);
        }}
      >
        <span className="tree-caret"><ThemeIcon id={expanded ? "chevron-down" : "chevron-right"} /></span>
        <AssetIcon pluginId={connection.pluginId} icon={icon} />
        <span>{connection.name}</span>
        <span className="row-actions">
          {onOpenDashboard && (
            <button
              className="icon-button"
              title={`Open ${dashboard?.title ?? "Dashboard"}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenDashboard();
              }}
            >
              <ThemeIcon id="results" />
            </button>
          )}
          <button
            className="icon-button"
            title="More Actions…"
            onClick={(e) => {
              e.stopPropagation();
              onContextMenu(e, undefined, refreshRoot);
            }}
          >
            <ThemeIcon id="ellipsis" />
          </button>
        </span>
      </div>
      {expanded && (
        <ConnectionRootNodes
          connectionId={connection.id}
          pluginId={connection.pluginId}
          version={rootVersion}
          onOpenView={onOpenNodeView}
          onContextMenu={onNodeContextMenu}
        />
      )}
    </div>
  );
}
