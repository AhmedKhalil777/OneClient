import { contextBridge, ipcRenderer } from "electron";
import { IpcChannel, type OneClientApi } from "../shared/ipc-contract.js";

function onEvent<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: OneClientApi = {
  getRegistry: () => ipcRenderer.invoke(IpcChannel.RegistryGet),
  onRegistryChanged: (listener) => onEvent(IpcChannel.RegistryChanged, listener),

  listPlugins: () => ipcRenderer.invoke(IpcChannel.PluginList),
  onPluginsChanged: (listener) => onEvent(IpcChannel.PluginsChanged, listener),
  setPluginEnabled: (pluginId, enabled) => ipcRenderer.invoke(IpcChannel.PluginSetEnabled, pluginId, enabled),

  executeCommand: (commandId, args) => ipcRenderer.invoke(IpcChannel.CommandExecute, commandId, args),

  listConnections: () => ipcRenderer.invoke(IpcChannel.ConnectionList),
  onConnectionsChanged: (listener) => onEvent(IpcChannel.ConnectionsChanged, listener),
  getConnectionForm: (typeId) => ipcRenderer.invoke(IpcChannel.ConnectionGetForm, typeId),
  testConnection: (typeId, config) => ipcRenderer.invoke(IpcChannel.ConnectionTest, typeId, config),
  createConnection: (typeId, name, config) => ipcRenderer.invoke(IpcChannel.ConnectionCreate, typeId, name, config),
  deleteConnection: (id) => ipcRenderer.invoke(IpcChannel.ConnectionDelete, id),

  searchProviders: () => ipcRenderer.invoke(IpcChannel.SearchProviders),
  runSearch: (providerId, query) => ipcRenderer.invoke(IpcChannel.SearchRun, providerId, query),

  exportConnections: (includeSecrets) => ipcRenderer.invoke(IpcChannel.ConnectionExport, includeSecrets),
  importConnections: () => ipcRenderer.invoke(IpcChannel.ConnectionImport),
  revealConfigFile: () => ipcRenderer.invoke(IpcChannel.ConfigReveal),

  getExplorerChildren: (connectionId, node) => ipcRenderer.invoke(IpcChannel.ExplorerGetChildren, connectionId, node),

  openView: (instanceId, pluginId, viewId, connectionId, params) =>
    ipcRenderer.invoke(IpcChannel.ViewOpen, instanceId, pluginId, viewId, connectionId, params),
  closeView: (instanceId) => ipcRenderer.invoke(IpcChannel.ViewClose, instanceId),
  setViewBounds: (instanceId, bounds) => ipcRenderer.invoke(IpcChannel.ViewSetBounds, instanceId, bounds),
  onViewDirtyChanged: (listener) => onEvent(IpcChannel.ViewDirtyChanged, listener),
  focusView: (instanceId) => ipcRenderer.invoke(IpcChannel.ViewFocus, instanceId),
  onShortcut: (listener) => onEvent(IpcChannel.Shortcut, listener),
  onRevealView: (listener) => onEvent(IpcChannel.RevealView, listener),
  onOpenViewRequest: (listener) => onEvent(IpcChannel.OpenViewRequest, listener),

  getOutput: () => ipcRenderer.invoke(IpcChannel.OutputList),
  onOutputEntry: (listener) => onEvent(IpcChannel.OutputEntry, listener),
  onOutputCleared: (listener) => onEvent(IpcChannel.OutputCleared, listener),
  onOutputReveal: (listener) => onEvent(IpcChannel.OutputReveal, listener),
  clearOutput: (channelId) => ipcRenderer.invoke(IpcChannel.OutputClear, channelId),

  pickDirectory: (defaultPath) => ipcRenderer.invoke(IpcChannel.DialogPickDirectory, defaultPath),

  getThemeState: () => ipcRenderer.invoke(IpcChannel.ThemeGetState),
  onThemeChanged: (listener) => onEvent(IpcChannel.ThemeChanged, listener),
  listColorThemes: () => ipcRenderer.invoke(IpcChannel.ThemeListColor),
  listIconThemes: () => ipcRenderer.invoke(IpcChannel.ThemeListIcon),
  setColorTheme: (id, persist) => ipcRenderer.invoke(IpcChannel.ThemeSetColor, id, persist ?? true),
  setIconTheme: (id, persist) => ipcRenderer.invoke(IpcChannel.ThemeSetIcon, id, persist ?? true),
};

contextBridge.exposeInMainWorld("oneclient", api);
