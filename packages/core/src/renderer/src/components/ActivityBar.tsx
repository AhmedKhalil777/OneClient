import type { PluginSummary } from "../../../shared/types.js";
import { ThemeIcon } from "../theme.js";
import { AssetIcon } from "./AssetIcon.js";

/** Which view container the sidebar shows: core's Explorer or Search, one plugin's explorer, or the Plugins list. */
export type ViewContainerId = `plugin:${string}` | "explorer" | "search" | "scm" | "plugins";

/**
 * VS Code-style activity bar: core's Explorer and Search first, then one icon per plugin that has an explorer
 * (i.e. contributes connection types), and Plugins / Manage pinned to the bottom. Clicking the already-selected
 * icon collapses the sidebar; clicking it again restores it.
 */
export function ActivityBar({
  scmCount,
  plugins,
  active,
  sidebarVisible,
  onSelect,
  onManage,
}: {
  /** Changes across the open repositories (the Source Control badge). */
  scmCount: number;
  plugins: PluginSummary[];
  active: ViewContainerId;
  sidebarVisible: boolean;
  onSelect: (id: ViewContainerId) => void;
  /** The gear at the bottom: opens the Manage menu (themes, plugins, command palette). */
  onManage: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="activity-bar">
      <div className="activity-bar-group">
        <ActivityItem title="Explorer (Ctrl+Shift+E)" selected={sidebarVisible && active === "explorer"} onClick={() => onSelect("explorer")}>
          <ThemeIcon id="files" size={24} />
        </ActivityItem>
        <ActivityItem title="Search (Ctrl+Shift+F)" selected={sidebarVisible && active === "search"} onClick={() => onSelect("search")}>
          <ThemeIcon id="search" size={24} />
        </ActivityItem>
        <ActivityItem title={`Source Control (Ctrl+Shift+G)${scmCount ? ` — ${scmCount} pending change${scmCount === 1 ? "" : "s"}` : ""}`} selected={sidebarVisible && active === "scm"} onClick={() => onSelect("scm")}>
          <ThemeIcon id="source-control" size={24} />
          {scmCount > 0 && <span className="activity-badge">{scmCount > 999 ? "999+" : scmCount}</span>}
        </ActivityItem>
        {plugins.length > 0 && <div className="activity-bar-separator" />}
        {plugins.map((p) => {
          const id: ViewContainerId = `plugin:${p.id}`;
          return (
            <ActivityItem
              key={p.id}
              title={p.displayName ?? p.id}
              selected={sidebarVisible && active === id}
              dimmed={p.state !== "active"}
              onClick={() => onSelect(id)}
            >
              <AssetIcon pluginId={p.id} icon={p.icon} size={24} />
            </ActivityItem>
          );
        })}
      </div>
      <div className="activity-bar-group">
        <ActivityItem title="Plugins" selected={sidebarVisible && active === "plugins"} onClick={() => onSelect("plugins")}>
          <ThemeIcon id="extensions" size={24} />
        </ActivityItem>
        <ActivityItem title="Manage" selected={false} onClick={onManage}>
          <ThemeIcon id="gear" size={24} />
        </ActivityItem>
      </div>
    </div>
  );
}

function ActivityItem({
  title,
  selected,
  dimmed,
  onClick,
  children,
}: {
  title: string;
  selected: boolean;
  dimmed?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`activity-item ${selected ? "selected" : ""} ${dimmed ? "dimmed" : ""}`}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

