import type { PluginSummary } from "../../../shared/types.js";
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
}: {
  plugins: PluginSummary[];
  active: ViewContainerId;
  sidebarVisible: boolean;
  onSelect: (id: ViewContainerId) => void;
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
          <PluginsGlyph />
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
  onClick: () => void;
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

function PluginsGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="13.5" y="2.5" width="7" height="7" rx="1" transform="rotate(15 17 6)" />
    </svg>
  );
}
