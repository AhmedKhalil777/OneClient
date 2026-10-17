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
} as const;

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

  getExplorerChildren(connectionId: string, node: TreeNode | null): Promise<TreeNode[]>;

  /** Opens (or no-ops if already open) a Tier 2 view instance; resolves once the WebContentsView starts loading. */
  openView(instanceId: string, pluginId: string, viewId: string, connectionId?: string): Promise<void>;
  closeView(instanceId: string): Promise<void>;
  setViewBounds(instanceId: string, bounds: ViewBounds): Promise<void>;
}
