import { useState } from "react";
import type { CommandContribution, ConnectionTypeContribution, ExplorerSectionContribution, TreeNode, ViewContribution } from "@oneclient/plugin-api";
import type { ConnectionSummary, PluginSummary } from "@oneclient/backend/shared/types.js";
import type { ViewContainerId } from "./ActivityBar.js";
import { ThemeIcon } from "../theme.js";
import { AssetIcon } from "./AssetIcon.js";
import { ConnectionRootNodes, ExplorerTreeNode, type NodeContextMenuFn, type OpenNodeViewFn } from "./ExplorerTree.js";
import { connectionLabel } from "../connection-label.js";
import { isNewer, usePluginRegistry } from "./usePluginRegistry.js";

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
type Section = ExplorerSectionContribution & { pluginId: string };

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
  onOpenPlugin,
  onOpenDashboard,
  onOpenNodeView,
  onExplorerContextMenu,
  explorerTokens = {},
  explorerSections = [],
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
  /** Open a plugin's own page (installed or not). */
  onOpenPlugin: (pluginId: string, title?: string) => void;
  onOpenDashboard: (connection: ConnectionSummary, view: DashboardView) => void;
  onOpenNodeView: (connection: ConnectionSummary, node: TreeNode) => void;
  onExplorerContextMenu: ExplorerContextMenuFn;
  /** Per connection: bumping it re-fetches that connection's tree. */
  explorerTokens?: Record<string, number>;
  explorerSections?: Section[];
}) {
  if (container === "plugins") {
    return <PluginsContainer plugins={plugins} onOpenPluginManager={onOpenPluginManager} onOpenPlugin={onOpenPlugin} />;
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
      explorerTokens={explorerTokens}
      sections={explorerSections.filter((x) => x.pluginId === plugin.id)}
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
  explorerTokens,
  sections,
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
  explorerTokens: Record<string, number>;
  sections: Section[];
}) {
  // Bumping this remounts every connection tree, re-fetching its children.
  const [refreshKey, setRefreshKey] = useState(0);
  const containerId = `plugin:${plugin.id}`;
  const canConnect = connectionTypes.length > 0 && plugin.state === "active";
  const noun = connectionLabel(connectionTypes);

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
          title={noun.many}
          count={connections.length}
          actions={
            <>
              <button className="icon-button" title={`Add ${noun.one}`} disabled={!canConnect} onClick={onNewConnection}>
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
              No {noun.many.toLowerCase()} yet.{" "}
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
                  refreshToken={explorerTokens[c.id] ?? 0}
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

      {sections.map((section) => {
        const scoped = connections.filter((c) => !section.connectionType || c.typeId === section.connectionType);
        return (
          <SidebarSection
            key={section.id}
            containerId={containerId}
            sectionId={`section:${section.id}`}
            title={section.title}
            defaultExpanded={!section.collapsed}
            actions={
              <button className="icon-button" title="Refresh" onClick={() => setRefreshKey((k) => k + 1)}>
                <ThemeIcon id="refresh" />
              </button>
            }
          >
            {scoped.length === 0 ? (
              <div className="empty-hint">
                Add a {noun.one.toLowerCase()} to use {section.title}.
              </div>
            ) : (
              scoped.map((c) => {
                const connectionType = connectionTypes.find((t) => t.id === c.typeId);
                // A synthetic root per connection; the plugin's provider supplies its children.
                const root: TreeNode = {
                  id: `section:${section.id}:${c.id}`,
                  label: c.name,
                  nodeType: section.rootNodeType,
                  contextValue: section.rootNodeType,
                  collapsible: scoped.length === 1 ? "expanded" : "collapsed",
                  ...(connectionType?.icon ? { icon: connectionType.icon } : {}),
                };
                return (
                  <ExplorerTreeNode
                    key={`${section.id}:${c.id}:${refreshKey}`}
                    refreshToken={explorerTokens[c.id] ?? 0}
                    connectionId={c.id}
                    pluginId={c.pluginId}
                    node={root}
                    depth={0}
                    onOpenView={(node) => onOpenNodeView(c, node)}
                    onContextMenu={(e, node, refresh) => onExplorerContextMenu(e, c, node, refresh)}
                    reloadParent={() => setRefreshKey((k) => k + 1)}
                  />
                );
              })
            )}
          </SidebarSection>
        );
      })}

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

/** The Plugins view: what is installed, and — from GitHub Packages — what else can be installed from GitHub Releases. (The optional GitHub token is set in the Plugin Manager.) */
function PluginsContainer({ plugins, onOpenPluginManager, onOpenPlugin }: { plugins: PluginSummary[]; onOpenPluginManager: () => void; onOpenPlugin: (pluginId: string, title?: string) => void }) {
  const { available, loading, busy, error, refresh, install, uninstall } = usePluginRegistry();
  const installed = new Set(plugins.map((p) => p.id));
  const notInstalled = (available ?? []).filter((a) => !installed.has(a.id));
  const latest = new Map((available ?? []).map((a) => [a.id, a.latest]));
  const stop = (e: React.MouseEvent) => e.stopPropagation();

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
        {plugins.map((p) => {
          const newer = p.removable && latest.get(p.id) && isNewer(latest.get(p.id)!, p.version) ? latest.get(p.id) : undefined;
          return (
            <div className="tree-row" key={p.id} onClick={() => onOpenPlugin(p.id, p.displayName)}>
              <AssetIcon pluginId={p.id} icon={p.icon} />
              <span>{p.displayName ?? p.id}</span>
              <span className={`badge badge-${p.state}`}>{p.state}</span>
              {newer && (
                <button className="btn plugin-row-btn" disabled={Boolean(busy[p.id])} title={`Update to v${newer}`} onClick={(e) => (stop(e), void install(p.id))}>
                  {busy[p.id] === "installing" ? "Updating…" : "Update"}
                </button>
              )}
              {p.removable && (
                <button className="btn plugin-row-btn" disabled={Boolean(busy[p.id])} title="Uninstall this plugin" onClick={(e) => (stop(e), uninstall(p))}>
                  {busy[p.id] === "uninstalling" ? "Removing…" : "Uninstall"}
                </button>
              )}
            </div>
          );
        })}
      </SidebarSection>
      <SidebarSection
        containerId="plugins"
        sectionId="available"
        title="Available"
        {...(available ? { count: notInstalled.length } : {})}
        actions={
          <button className="icon-button" title="Refresh the list" disabled={loading} onClick={() => void refresh()}>
            <ThemeIcon id="refresh" />
          </button>
        }
      >
        {loading && <div className="plugin-setup">Checking for plugins…</div>}
        {error && <div className="plugin-setup pm-error">{error}</div>}
        {available && notInstalled.length === 0 && !error && <div className="plugin-setup">{available.length === 0 ? "No plugin has been released for this version yet." : "Every released plugin is installed."}</div>}
        {notInstalled.map((a) => (
          <div className="tree-row" key={a.id} title={a.description} onClick={() => onOpenPlugin(a.id)}>
            <span>{a.id}</span>
            <span className="badge badge-inactive">v{a.latest}</span>
            <button className="btn btn-primary plugin-row-btn" disabled={Boolean(busy[a.id])} onClick={(e) => (stop(e), void install(a.id))}>
              {busy[a.id] ? "Installing…" : "Install"}
            </button>
          </div>
        ))}
      </SidebarSection>
    </div>
  );
}

/** A collapsible VS Code-style section; its expanded state is remembered per container. */
export function SidebarSection({
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
        <span className="section-label" title={title}>{title.toUpperCase()}</span>
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
  refreshToken,
}: {
  connection: ConnectionSummary;
  /** Bumped when the plugin asks to refresh this connection's tree. */
  refreshToken: number;
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
          refreshToken={refreshToken}
          onOpenView={onOpenNodeView}
          onContextMenu={onNodeContextMenu}
        />
      )}
    </div>
  );
}
