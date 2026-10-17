import { join } from "node:path";
import { type BrowserWindow, ipcMain } from "electron";
import type { TreeNode } from "@oneclient/plugin-api";
import { IpcChannel, type ViewBounds } from "../../shared/ipc-contract.js";
import type { ConnectionSummary, ContributionRegistrySnapshot, PluginSummary } from "../../shared/types.js";
import type { ConnectionManager } from "../connections/connection-manager.js";
import type { ExtensionHostSupervisor } from "../plugins/extension-host-supervisor.js";
import type { PluginManager } from "../plugins/plugin-manager.js";
import type { ContributionRegistry } from "../plugins/registry.js";
import type { ViewHostManager } from "../views/view-host-manager.js";

export interface IpcDeps {
  registry: ContributionRegistry;
  pluginManager: PluginManager;
  connections: ConnectionManager;
  supervisor: ExtensionHostSupervisor;
  views: ViewHostManager;
  ensureActivated: (pluginId: string) => Promise<void>;
  getWindows: () => BrowserWindow[];
}

/** Registers every main-process IPC handler and wires registry/plugin change events to all open windows. */
export function registerIpcHandlers(deps: IpcDeps): void {
  const { registry, pluginManager, connections, supervisor, views, ensureActivated, getWindows } = deps;

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  registry.onChanged((snapshot: ContributionRegistrySnapshot) => broadcast(IpcChannel.RegistryChanged, snapshot));
  pluginManager.on("changed", (summaries: PluginSummary[]) => broadcast(IpcChannel.PluginsChanged, summaries));

  ipcMain.handle(IpcChannel.RegistryGet, () => registry.snapshot());

  ipcMain.handle(IpcChannel.PluginList, (): PluginSummary[] =>
    pluginManager.getRecords().map((r) => ({
      id: r.id,
      displayName: r.manifest?.displayName,
      version: r.manifest?.version ?? "0.0.0",
      state: r.state,
      error: r.error,
    })),
  );

  ipcMain.handle(IpcChannel.PluginSetEnabled, async (_event, pluginId: string, enabled: boolean) => {
    pluginManager.setEnabled(pluginId, enabled);
    if (!enabled) await supervisor.deactivate(pluginId);
  });

  ipcMain.handle(IpcChannel.CommandExecute, async (_event, commandId: string, args: unknown[] = []) => {
    const pluginId = registry.findCommandOwner(commandId);
    if (!pluginId) throw new Error(`No installed plugin contributes command "${commandId}".`);
    await ensureActivated(pluginId);
    return supervisor.invoke(pluginId, "command", commandId, "execute", [args]);
  });

  ipcMain.handle(IpcChannel.ConnectionList, (): ConnectionSummary[] => connections.list());
  ipcMain.handle(IpcChannel.ConnectionGetForm, (_event, typeId: string) => connections.getFormInfo(typeId));
  ipcMain.handle(IpcChannel.ConnectionTest, (_event, typeId: string, config: Record<string, unknown>) =>
    connections.test(typeId, config),
  );
  ipcMain.handle(
    IpcChannel.ConnectionCreate,
    async (_event, typeId: string, name: string, config: Record<string, unknown>) => {
      const summary = await connections.create(typeId, name, config);
      broadcast(IpcChannel.ConnectionsChanged, connections.list());
      return summary;
    },
  );
  ipcMain.handle(IpcChannel.ConnectionDelete, async (_event, id: string) => {
    await connections.delete(id);
    broadcast(IpcChannel.ConnectionsChanged, connections.list());
  });

  ipcMain.handle(
    IpcChannel.ExplorerGetChildren,
    async (_event, connectionId: string, node: TreeNode | null): Promise<TreeNode[]> => {
      const { pluginId, typeId } = await connections.ensureConnected(connectionId);

      if (node === null) {
        // Root level: every explorerNodes contribution declared for this connection's
        // type with no parent is a root category — fan out and concatenate.
        const rootNodeTypes = registry
          .snapshot()
          .explorerNodes.filter((n) => n.connectionType === typeId && !n.parentNodeType)
          .map((n) => n.id);
        const results = await Promise.all(
          rootNodeTypes.map((nodeType) =>
            supervisor.invoke(pluginId, "explorer", nodeType, "getChildren", [null], connectionId),
          ),
        );
        return results.flat() as TreeNode[];
      }

      return supervisor.invoke(pluginId, "explorer", node.nodeType, "getChildren", [node], connectionId) as Promise<
        TreeNode[]
      >;
    },
  );

  ipcMain.handle(
    IpcChannel.ViewOpen,
    async (_event, instanceId: string, pluginId: string, viewId: string, connectionId?: string) => {
      const viewContribution = registry
        .snapshot()
        .views.find((v) => v.id === viewId && v.pluginId === pluginId);
      if (!viewContribution?.entry) throw new Error(`No Tier 2 view "${viewId}" contributed by "${pluginId}".`);

      const record = pluginManager.getRecord(pluginId);
      if (!record?.manifest.ui) throw new Error(`Plugin "${pluginId}" has no "ui" bundle declared in its manifest.`);

      await ensureActivated(pluginId);
      if (connectionId) await connections.ensureConnected(connectionId);

      views.open({
        instanceId,
        pluginId,
        viewId,
        connectionId,
        entryDir: join(record.rootDir, record.manifest.ui),
        entryFile: viewContribution.entry,
      });
    },
  );

  ipcMain.handle(IpcChannel.ViewClose, (_event, instanceId: string) => {
    const instance = views.getInstance(instanceId);
    views.close(instanceId);
    if (instance) supervisor.sendViewDispose(instance.pluginId, instance.viewId, instance.connectionId);
  });

  ipcMain.handle(IpcChannel.ViewSetBounds, (_event, instanceId: string, bounds: ViewBounds) => {
    views.setBounds(instanceId, bounds);
  });
}
