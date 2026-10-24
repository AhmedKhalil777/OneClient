import type {
  ColorThemeContribution,
  IconContribution,
  IconThemeContribution,
  CommandContribution,
  ConnectionTestResult,
  ConnectionTypeContribution,
  MenuContribution, SearchProviderContribution,
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
