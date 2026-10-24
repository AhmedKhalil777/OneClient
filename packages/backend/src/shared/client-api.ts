import { IpcChannel, type OneClientApi } from "./ipc-contract.js";

/** How a shell reaches the backend: Electron IPC (preload) or the web server's WebSocket (the browser bridge). */
export interface ClientTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** Subscribes to a broadcast event; returns the unsubscribe function. */
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

/**
 * `window.oneclient` — the shell's whole API — over any transport. The desktop preload and the web bridge both build it
 * here, so the two runtimes can't drift apart; the web bridge then replaces the few calls that are browser-local
 * (view placement, window actions, dialogs).
 */
export function createClientApi(t: ClientTransport): OneClientApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (channel: string, ...args: unknown[]) => t.invoke(channel, ...args) as Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const on = (channel: string) => (listener: (payload: any) => void) => t.on(channel, listener);
  return {
    getRegistry: () => call(IpcChannel.RegistryGet),
    onRegistryChanged: on(IpcChannel.RegistryChanged),

    listPlugins: () => call(IpcChannel.PluginList),
    onPluginsChanged: on(IpcChannel.PluginsChanged),
    setPluginEnabled: (pluginId, enabled) => call(IpcChannel.PluginSetEnabled, pluginId, enabled),

    executeCommand: (commandId, args) => call(IpcChannel.CommandExecute, commandId, args),

    listConnections: () => call(IpcChannel.ConnectionList),
    onConnectionsChanged: on(IpcChannel.ConnectionsChanged),
    getConnectionForm: (typeId) => call(IpcChannel.ConnectionGetForm, typeId),
    testConnection: (typeId, config) => call(IpcChannel.ConnectionTest, typeId, config),
    createConnection: (typeId, name, config) => call(IpcChannel.ConnectionCreate, typeId, name, config),
    deleteConnection: (id) => call(IpcChannel.ConnectionDelete, id),

    searchProviders: () => call(IpcChannel.SearchProviders),
    runSearch: (providerId, query) => call(IpcChannel.SearchRun, providerId, query),

    exportConnections: (includeSecrets) => call(IpcChannel.ConnectionExport, includeSecrets),
    importConnections: () => call(IpcChannel.ConnectionImport),
    revealConfigFile: () => call(IpcChannel.ConfigReveal),

    getExplorerChildren: (connectionId, node) => call(IpcChannel.ExplorerGetChildren, connectionId, node),

    openView: (instanceId, pluginId, viewId, connectionId, params) => call(IpcChannel.ViewOpen, instanceId, pluginId, viewId, connectionId, params),
    closeView: (instanceId) => call(IpcChannel.ViewClose, instanceId),
    setViewBounds: (instanceId, bounds) => call(IpcChannel.ViewSetBounds, instanceId, bounds),
    onViewDirtyChanged: on(IpcChannel.ViewDirtyChanged),
    focusView: (instanceId) => call(IpcChannel.ViewFocus, instanceId),
    onShortcut: on(IpcChannel.Shortcut),
    onRevealView: on(IpcChannel.RevealView),
    onOpenViewRequest: on(IpcChannel.OpenViewRequest),
    onExplorerRefresh: on(IpcChannel.ExplorerRefresh),

    getOutput: () => call(IpcChannel.OutputList),
    onOutputEntry: on(IpcChannel.OutputEntry),
    onOutputCleared: on(IpcChannel.OutputCleared),
    onOutputReveal: on(IpcChannel.OutputReveal),
    clearOutput: (channelId) => call(IpcChannel.OutputClear, channelId),

    workspaceFolders: () => call(IpcChannel.WorkspaceFolders),
    addWorkspaceFolder: (path) => call(IpcChannel.WorkspaceAddFolder, path),
    removeWorkspaceFolder: (id) => call(IpcChannel.WorkspaceRemoveFolder, id),
    onWorkspaceChanged: on(IpcChannel.WorkspaceChanged),
    revealPath: (path) => call(IpcChannel.RevealPath, path),

    listTasks: () => call(IpcChannel.TasksList),
    onTasksChanged: on(IpcChannel.TasksChanged),
    taskOutput: (id) => call(IpcChannel.TaskOutput, id),
    onTaskOutput: on(IpcChannel.TaskOutputChunk),
    cancelTask: (id) => call(IpcChannel.TaskCancel, id),
    clearFinishedTasks: () => call(IpcChannel.TasksClear),
    taskDefinitions: () => call(IpcChannel.TaskDefinitions),
    runTask: (definitionId) => call(IpcChannel.TaskRun, definitionId),

    gitRepos: () => call(IpcChannel.GitRepos),
    onGitChanged: on(IpcChannel.GitChanged),
    git: (method, ...args) => call(IpcChannel.GitCall, method, args),
    openWorkspaceFile: (path, options) => call(IpcChannel.WorkspaceOpen, path, options ?? {}),
    onOpenWorkspaceFile: on(IpcChannel.WorkspaceOpenFile),

    windowAction: (action) => call(IpcChannel.WindowAction, action),
    editAction: (role, instanceId) => call(IpcChannel.EditAction, role, instanceId),
    sendKeyToView: (instanceId, key) => call(IpcChannel.ViewSendKey, instanceId, key),
    appInfo: () => call(IpcChannel.AppInfo),
    setTitleBarColors: (background, foreground) => call(IpcChannel.TitleBarColors, background, foreground),
    onFullScreenChanged: on(IpcChannel.FullScreenChanged),

    pickDirectory: (defaultPath) => call(IpcChannel.DialogPickDirectory, defaultPath),

    getThemeState: () => call(IpcChannel.ThemeGetState),
    onThemeChanged: on(IpcChannel.ThemeChanged),
    listColorThemes: () => call(IpcChannel.ThemeListColor),
    listIconThemes: () => call(IpcChannel.ThemeListIcon),
    setColorTheme: (id, persist) => call(IpcChannel.ThemeSetColor, id, persist ?? true),
    setIconTheme: (id, persist) => call(IpcChannel.ThemeSetIcon, id, persist ?? true),
  };
}
