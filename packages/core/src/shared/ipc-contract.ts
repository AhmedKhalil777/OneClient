import type { OutputChannelInfo, OutputChannelState, OutputEntry } from "./output.js";
import type {
  ConnectionSummary,
  ConnectionTestResult,
  ConnectionTypeFormInfo,
  ContributionRegistrySnapshot,
  PluginSummary,
  TreeNode,
} from "./types.js";

/** IPC channel names, namespaced to avoid colliding with anything else on the same WebContents. */
export const IpcChannel = {
  RegistryGet: "oneclient:registry:get",
  RegistryChanged: "oneclient:registry:changed",

  PluginList: "oneclient:plugin:list",
  PluginsChanged: "oneclient:plugin:changed",
  PluginSetEnabled: "oneclient:plugin:setEnabled",

  CommandExecute: "oneclient:command:execute",

  ConnectionList: "oneclient:connection:list",
  ConnectionGetForm: "oneclient:connection:getForm",
  ConnectionTest: "oneclient:connection:test",
  ConnectionCreate: "oneclient:connection:create",
  ConnectionDelete: "oneclient:connection:delete",
  ConnectionsChanged: "oneclient:connection:changed",

  ExplorerGetChildren: "oneclient:explorer:getChildren",

  ViewOpen: "oneclient:view:open",
  ViewClose: "oneclient:view:close",
  ViewSetBounds: "oneclient:view:setBounds",
  ViewDirtyChanged: "oneclient:view:dirtyChanged",
  ViewFocus: "oneclient:view:focus",

  /** A workbench shortcut pressed while focus was inside a Tier 2 view (which swallows key events). */
  Shortcut: "oneclient:shortcut",
  /** A view asked to show another view of its plugin. */
  RevealView: "oneclient:view:reveal",
  /** A view asked to open another view of its plugin in a new tab. */
  OpenViewRequest: "oneclient:view:openRequest",

  OutputList: "oneclient:output:list",
  OutputEntry: "oneclient:output:entry",
  OutputCleared: "oneclient:output:cleared",
  OutputReveal: "oneclient:output:reveal",
  OutputClear: "oneclient:output:clear",

  ConnectionExport: "oneclient:connection:export",
  ConnectionImport: "oneclient:connection:import",
  ConfigReveal: "oneclient:config:reveal",

  DialogPickDirectory: "oneclient:dialog:pickDirectory",

  ThemeGetState: "oneclient:theme:getState",
  ThemeChanged: "oneclient:theme:changed",
  ThemeListColor: "oneclient:theme:listColor",
  ThemeListIcon: "oneclient:theme:listIcon",
  ThemeSetColor: "oneclient:theme:setColor",
  ThemeSetIcon: "oneclient:theme:setIcon",
} as const;

import type { ThemeKind, ThemeState } from "@oneclient/plugin-api";

export interface OpenViewEvent {
  pluginId: string;
  connectionId?: string | undefined;
  viewId: string;
  title: string;
  params: Record<string, string>;
  icon?: string;
}

export interface ThemeListItem {
  id: string;
  label: string;
  kind?: ThemeKind;
  pluginId?: string;
}

/** Workbench-level shortcuts that must work even while a Tier 2 view has focus. */
export type WorkbenchShortcut = "togglePanel" | "commandPalette";

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The renderer-facing API shape. Preload implements this by wrapping
 * ipcRenderer.invoke/on; main implements the handler side. Keeping one
 * interface for both ends means a signature change is a compile error in
 * whichever side didn't get updated.
 */
export interface OneClientApi {
  getRegistry(): Promise<ContributionRegistrySnapshot>;
  onRegistryChanged(listener: (snapshot: ContributionRegistrySnapshot) => void): () => void;

  listPlugins(): Promise<PluginSummary[]>;
  onPluginsChanged(listener: (plugins: PluginSummary[]) => void): () => void;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<void>;

  executeCommand(commandId: string, args?: unknown[]): Promise<unknown>;

  listConnections(): Promise<ConnectionSummary[]>;
  onConnectionsChanged(listener: (connections: ConnectionSummary[]) => void): () => void;
  getConnectionForm(typeId: string): Promise<ConnectionTypeFormInfo>;
  testConnection(typeId: string, config: Record<string, unknown>): Promise<ConnectionTestResult>;
  createConnection(
    typeId: string,
    name: string,
    config: Record<string, unknown>,
  ): Promise<ConnectionSummary>;
  deleteConnection(id: string): Promise<void>;

  /** Save the connections to a JSON file the user picks. Passwords are only included when asked (then in plain text). Null = cancelled. */
  exportConnections(includeSecrets: boolean): Promise<{ path: string; count: number; includesSecrets: boolean } | null>;
  /** Pick a JSON file (an export, or another oneclient.json) and add its connections. Null = cancelled. */
  importConnections(): Promise<{ path: string; added: number; skipped: number; invalid: number; withoutSecrets: number; warnings: string[] } | null>;
  /** Show ~/.oneclient/oneclient.json in the file manager. */
  revealConfigFile(): Promise<void>;

  getExplorerChildren(connectionId: string, node: TreeNode | null): Promise<TreeNode[]>;

  /**
   * Opens (or no-ops if already open) a Tier 2 view instance; resolves once the WebContentsView starts loading.
   * `params` become URL query parameters on the view's entry page (see `TreeNode.openView`).
   */
  openView(
    instanceId: string,
    pluginId: string,
    viewId: string,
    connectionId?: string,
    params?: Record<string, string>,
  ): Promise<void>;
  closeView(instanceId: string): Promise<void>;
  setViewBounds(instanceId: string, bounds: ViewBounds): Promise<void>;
  /** A Tier 2 view instance gained/lost unsaved changes (`ViewHostApi.setDirty`). */
  onViewDirtyChanged(listener: (event: { instanceId: string; dirty: boolean }) => void): () => void;
  /** Give keyboard focus to a Tier 2 view instance (e.g. the terminal when its panel opens). */
  focusView(instanceId: string): Promise<void>;
  onShortcut(listener: (shortcut: WorkbenchShortcut) => void): () => void;
  onRevealView(listener: (event: { pluginId: string; viewId: string }) => void): () => void;
  /** A plugin view asked for a new tab (`ViewHostApi.openView`); the shell decides whether it's allowed. */
  onOpenViewRequest(listener: (event: OpenViewEvent) => void): () => void;

  /** The Output panel: every channel with its buffered entries, then live updates. */
  getOutput(): Promise<OutputChannelState[]>;
  onOutputEntry(listener: (event: { channel: OutputChannelInfo; entry: OutputEntry }) => void): () => void;
  onOutputCleared(listener: (channelId: string) => void): () => void;
  /** A plugin asked to show a channel (`OutputChannel.show()`). */
  onOutputReveal(listener: (channelId: string) => void): () => void;
  clearOutput(channelId: string): Promise<void>;

  /** Native "select folder" dialog; resolves to the chosen absolute path, or null if cancelled. */
  pickDirectory(defaultPath?: string): Promise<string | null>;

  getThemeState(): Promise<ThemeState>;
  onThemeChanged(listener: (state: ThemeState) => void): () => void;
  listColorThemes(): Promise<ThemeListItem[]>;
  listIconThemes(): Promise<ThemeListItem[]>;
  /** `persist: false` previews without saving (theme picker). */
  setColorTheme(id: string, persist?: boolean): Promise<void>;
  setIconTheme(id: string, persist?: boolean): Promise<void>;
}
