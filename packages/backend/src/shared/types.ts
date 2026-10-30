import type {
  ColorThemeContribution,
  IconContribution,
  IconThemeContribution,
  CommandContribution,
  ConnectionTestResult,
  ConnectionTypeContribution,
  MenuContribution, QuickActionContribution, SearchProviderContribution,
  ExplorerNodeContribution,
  ExplorerSectionContribution,
  JsonSchemaObject,
  TreeNode,
  UiSchema,
  ViewContribution,
} from "@oneclient/plugin-api";

/**
 * Runtime DTOs exchanged over IPC. Distinct from @oneclient/plugin-api's
 * design-time interfaces (ConnectionProvider, etc.) — those are what a
 * plugin implements *inside* its extension host; these are what the main
 * process tells the renderer about the result.
 */

export interface ContributionRegistrySnapshot {
  connectionTypes: Array<ConnectionTypeContribution & { pluginId: string }>;
  explorerNodes: Array<ExplorerNodeContribution & { pluginId: string }>;
  explorerSections: Array<ExplorerSectionContribution & { pluginId: string }>;
  views: Array<ViewContribution & { pluginId: string }>;
  commands: Array<CommandContribution & { pluginId: string }>;
  themes: Array<ColorThemeContribution & { pluginId: string }>;
  iconThemes: Array<IconThemeContribution & { pluginId: string }>;
  searchProviders: Array<SearchProviderContribution & { pluginId: string }>;
  menus: Array<MenuContribution & { pluginId: string }>;
  quickActions: Array<QuickActionContribution & { pluginId: string }>;
  icons: Array<IconContribution & { pluginId: string }>;
  /** Contributions to other plugins' extension points, one entry per (point, contributing plugin). */
  extensions: Array<{ point: string; pluginId: string; items: Array<Record<string, unknown>> }>;
}

export type PluginState =
  | "inactive"
  | "activating"
  | "active"
  | "crashed"
  | "disabled"
  | "incompatible"
  | "invalid";

export interface PluginSummary {
  id: string;
  displayName?: string;
  description?: string;
  version: string;
  state: PluginState;
  error?: string;
  /** Manifest `icon` path. Render via `oneclient-asset://<id>/<icon>` — never a raw filesystem path. */
  icon?: string;
  /** What it can do, by category (manifest `features`, normalised). */
  features?: PluginFeatureGroup[];
  /** Installed from the registry (not bundled with the app), so it can be uninstalled. */
  removable?: boolean;
}

/** A plugin in the catalog (plugin.json) with at least one release that supports this oneClient. */
export interface AvailablePlugin {
  /** The plugin's id (e.g. "oneclient-mysql"). */
  id: string;
  description?: string;
  /** Newest version that supports this oneClient. */
  latest: string;
  /** Every version that supports this oneClient, newest first. */
  versions: string[];
}

/** Everything the plugin page shows (VS Code's extension editor): installed or only on the registry. */
export interface PluginDetails {
  id: string;
  displayName?: string;
  description?: string;
  /** Installed version, or the newest one on the registry for a plugin that isn't installed. */
  version: string;
  installed: boolean;
  state?: PluginState;
  error?: string;
  removable?: boolean;
  publisher?: string;
  license?: string;
  repository?: string;
  engine?: string;
  icon?: string;
  /** The plugin's README.md (Markdown) — from its GitHub repository when reachable, else the installed copy or the registry's. */
  readme?: string;
  readmeSource?: "github" | "installed" | "registry";
  /** The README's page on GitHub: where relative links and images in it point, and the "View on GitHub" link. */
  readmeUrl?: string;
  features?: PluginFeatureGroup[];
  /** What it adds, by kind: "Commands", "Views", "Connection types"… */
  contributions?: Array<{ kind: string; items: Array<{ id: string; title?: string; description?: string }> }>;
  /** Newest version on the registry, when it could be looked up. */
  latestVersion?: string;
  /** A note when the registry couldn't be reached (the installed details are still shown). */
  registryError?: string;
}

/** Where plugins are downloaded from, and whether this app may read it. */
export interface PluginRegistryInfo {
  /** The GitHub repository plugins are released from, e.g. "ahmedkhalil777/OneClient". */
  scope: string;
  /** Where the plugin catalog (plugin.json) is read from. */
  url: string;
  /** A GitHub token is saved. It is optional: only for a private repository or to lift GitHub's anonymous rate limit. */
  hasToken: boolean;
  /** This oneClient's version — only plugin versions that support it are offered. */
  appVersion: string;
}

export interface PluginFeatureGroup {
  category: string;
  items: Array<{ title: string; description?: string }>;
}

export interface ConnectionSummary {
  id: string;
  name: string;
  typeId: string;
  pluginId: string;
}

export interface ConnectionTypeFormInfo {
  typeId: string;
  pluginId: string;
  configSchema: JsonSchemaObject;
  uiSchema?: UiSchema;
}

export type { ConnectionTestResult, TreeNode };
