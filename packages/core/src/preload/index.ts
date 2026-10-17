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

  getExplorerChildren: (connectionId, node) => ipcRenderer.invoke(IpcChannel.ExplorerGetChildren, connectionId, node),
};

contextBridge.exposeInMainWorld("oneclient", api);
