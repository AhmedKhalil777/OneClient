import type { PluginSummary } from "../../../shared/types.js";
import { ThemeIcon } from "../theme.js";
import { AssetIcon } from "./AssetIcon.js";

/** Which view container the sidebar shows: one plugin's explorer, or the built-in Plugins list. */
export type ViewContainerId = `plugin:${string}` | "plugins";

/**
 * VS Code-style activity bar: one icon per plugin that has an explorer
 * (i.e. contributes connection types), plus the built-in Plugins container
 * pinned to the bottom. Clicking the already-selected icon collapses the
 * sidebar; clicking it again restores it.
 */
export function ActivityBar({
  plugins,
  active,
  sidebarVisible,
  onSelect,
  onManage,
}: {
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

