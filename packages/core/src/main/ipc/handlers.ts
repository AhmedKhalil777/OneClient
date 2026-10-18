import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BrowserWindow, type OpenDialogOptions, app, dialog, ipcMain, shell } from "electron";
import type { ThemeState, TreeNode } from "@oneclient/plugin-api";
import { type AppInfo, type EditRole, IpcChannel, type ViewBounds, type ViewKey, type WindowAction } from "../../shared/ipc-contract.js";
import type { ConnectionSummary, ContributionRegistrySnapshot, PluginSummary } from "../../shared/types.js";
import type { ConfigStore } from "../config/config-store.js";
import type { ConnectionManager } from "../connections/connection-manager.js";
import type { ExtensionHostSupervisor } from "../plugins/extension-host-supervisor.js";
import type { PluginManager } from "../plugins/plugin-manager.js";
import type { ContributionRegistry } from "../plugins/registry.js";
import type { ThemeService } from "../themes/theme-service.js";
import type { SearchService } from "../search/search-service.js";
import type { OutputService } from "../output/output-service.js";
import type { ViewHostManager } from "../views/view-host-manager.js";
import type { WorkspaceService } from "../workspace/workspace-service.js";
import { TERMINAL_VIEW, type TerminalService } from "../terminal/terminal-service.js";
import { CORE_PLUGIN_ID } from "../../shared/core.js";
import { FILE_EDITORS_POINT, LEGACY_FILE_EDITORS_POINT } from "@oneclient/plugin-api";

export interface IpcDeps {
  themes: ThemeService;
  registry: ContributionRegistry;
  pluginManager: PluginManager;
  connections: ConnectionManager;
  search: SearchService;
  config: ConfigStore;
  supervisor: ExtensionHostSupervisor;
  views: ViewHostManager;
  output: OutputService;
  ensureActivated: (pluginId: string) => Promise<void>;
  getWindows: () => BrowserWindow[];
  workspace: WorkspaceService;
  /** Commands core implements itself (files.*, terminal.*), by id. */
  coreCommands: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  /** URL of a core view (file editor, terminal), or undefined for an unknown view id. */
  coreViewUrl: (viewId: string) => string | undefined;
  terminal: TerminalService;
  /** Opens a workspace file in the shell's editor (shared with plugins' context.workspace.openFile). */
  openWorkspaceFile: (path: string, options?: { line?: number | undefined; column?: number | undefined; length?: number | undefined }) => Promise<void>;
}

/** Registers every main-process IPC handler and wires registry/plugin change events to all open windows. */
export function registerIpcHandlers(deps: IpcDeps): void {
  const { registry, pluginManager, connections, search, config, supervisor, views, output, ensureActivated, getWindows, themes, workspace, openWorkspaceFile, coreCommands, coreViewUrl, terminal } = deps;
  const connectionsChanged = () => broadcast(IpcChannel.ConnectionsChanged, connections.list());

  // Themes: shell gets the full state; every Tier 2 view gets it too (its preload applies the CSS variables).
  // Plugin views don't draw file trees, so they skip the (potentially thousands of entries) file icon table.
  const forViews = (state: ThemeState): ThemeState => {
    const { fileIcons: _shellOnly, ...rest } = state;
    return rest;
  };
  themes.onChanged((state) => {
    broadcast(IpcChannel.ThemeChanged, state);
    views.broadcastTheme(forViews(state));
  });
  registry.onChanged(() => themes.onRegistryChanged());
  ipcMain.handle(IpcChannel.ThemeGetState, () => themes.getState());
  ipcMain.handle("oneclient-view:get-theme", () => forViews(themes.getState()));

  // Plugin-to-plugin extension points: views read what other plugins contributed (see ViewHostApi.getContributions).
  ipcMain.handle("oneclient-view:get-contributions", (_e, point: unknown) => {
    if (typeof point !== "string") return [];
    // The file editor's point was "oneclient-files.editors" while the editor lived in a plugin; plugins may still use it.
    if (point === FILE_EDITORS_POINT || point === LEGACY_FILE_EDITORS_POINT) return [...registry.getExtensions(FILE_EDITORS_POINT), ...registry.getExtensions(LEGACY_FILE_EDITORS_POINT)];
    return registry.getExtensions(point);
  });
  // A sandboxed view can't open links itself; main does it, for web/mail links only.
  ipcMain.on("oneclient-view:open-external", (_e, url: unknown) => {
    try {
      const parsed = new URL(String(url));
      if (["http:", "https:", "mailto:"].includes(parsed.protocol)) void shell.openExternal(parsed.toString());
    } catch {
      /* not a URL */
    }
  });
  ipcMain.handle(IpcChannel.ThemeListColor, () => themes.listColorThemes());
  ipcMain.handle(IpcChannel.ThemeListIcon, () => themes.listIconThemes());
  ipcMain.handle(IpcChannel.ThemeSetColor, (_e, id: string, persist: boolean) => themes.setColorTheme(id, persist));
  ipcMain.handle(IpcChannel.ThemeSetIcon, (_e, id: string, persist: boolean) => themes.setIconTheme(id, persist));

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  registry.onChanged((snapshot: ContributionRegistrySnapshot) => broadcast(IpcChannel.RegistryChanged, snapshot));
  pluginManager.on("changed", (summaries: PluginSummary[]) => broadcast(IpcChannel.PluginsChanged, summaries));
  views.onDirtyChanged((instanceId, dirty) => broadcast(IpcChannel.ViewDirtyChanged, { instanceId, dirty }));
  views.onShortcut((shortcut) => broadcast(IpcChannel.Shortcut, shortcut));
  views.onReveal((pluginId, viewId) => broadcast(IpcChannel.RevealView, { pluginId, viewId }));
  // Output panel: snapshot on demand, then live entries/clears/reveals.
  ipcMain.handle(IpcChannel.OutputList, () => output.snapshot());
  ipcMain.handle(IpcChannel.OutputClear, (_e, channelId: string) => output.clear(String(channelId)));
  output.onEntry((channel, entry) => broadcast(IpcChannel.OutputEntry, { channel, entry }));
  output.onCleared((channelId) => broadcast(IpcChannel.OutputCleared, channelId));
  output.onReveal((channelId) => broadcast(IpcChannel.OutputReveal, channelId));

  views.onRefreshExplorer((connectionId) => broadcast(IpcChannel.ExplorerRefresh, connectionId));
  views.onOpenView((pluginId, connectionId, request) => broadcast(IpcChannel.OpenViewRequest, { pluginId, connectionId, ...request }));
  ipcMain.handle(IpcChannel.ViewFocus, (_event, instanceId: string) => views.focus(instanceId));

  ipcMain.handle(IpcChannel.RegistryGet, () => registry.snapshot());

  ipcMain.handle(IpcChannel.PluginList, (): PluginSummary[] =>
    pluginManager.getRecords().map((r) => ({
      id: r.id,
      displayName: r.manifest?.displayName,
      description: r.manifest?.description,
      version: r.manifest?.version ?? "0.0.0",
      state: r.state,
      error: r.error,
      icon: r.manifest?.icon,
    })),
  );

  ipcMain.handle(IpcChannel.PluginSetEnabled, async (_event, pluginId: string, enabled: boolean) => {
    pluginManager.setEnabled(pluginId, enabled);
    if (!enabled) await supervisor.deactivate(pluginId);
  });

  ipcMain.handle(IpcChannel.CommandExecute, async (_event, commandId: string, args: unknown[] = []) => {
    // Core's own commands (the Explorer's files.*, the Terminal's terminal.*) come first.
    const core = coreCommands[commandId];
    if (core) return core((args[0] ?? {}) as Record<string, unknown>);
    const pluginId = registry.findCommandOwner(commandId);
    if (!pluginId) throw new Error(`No installed plugin contributes command "${commandId}".`);
    await ensureActivated(pluginId);
    // A command aimed at a connection (args[0].connectionId) gets it connected first, as the explorer would.
    const connectionId = (args[0] as { connectionId?: unknown } | undefined)?.connectionId;
    if (typeof connectionId === "string" && connections.list().some((c) => c.id === connectionId)) await connections.ensureConnected(connectionId);
    return supervisor.invoke(pluginId, "command", commandId, "execute", args);
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
      connectionsChanged();
      return summary;
    },
  );
  ipcMain.handle(IpcChannel.ConnectionDelete, async (_event, id: string) => {
    await connections.delete(id);
    connectionsChanged();
  });

  // Global search: which providers exist, then one provider at a time (results stream in as each answers).
  ipcMain.handle(IpcChannel.SearchProviders, () => search.providers());
  ipcMain.handle(IpcChannel.SearchRun, (_e, providerId: string, query: string) => search.run(String(providerId), String(query)));

  // Export / import saved connections (JSON), and a way to find the config file itself.
  const dialogParent = () => BrowserWindow.getFocusedWindow() ?? getWindows()[0];
  ipcMain.handle(IpcChannel.ConnectionExport, async (_event, includeSecrets: boolean) => {
    const parent = dialogParent();
    const options = {
      title: includeSecrets ? "Export connections (with passwords)" : "Export connections",
      defaultPath: join(app.getPath("documents"), "oneclient-connections.json"),
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return null;
    const document = await connections.exportConnections(includeSecrets === true);
    await writeFile(picked.filePath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf-8", mode: includeSecrets ? 0o600 : 0o644 });
    return { path: picked.filePath, count: document.connections.length, includesSecrets: document.includesSecrets };
  });
  ipcMain.handle(IpcChannel.ConnectionImport, async () => {
    const parent = dialogParent();
    const options: OpenDialogOptions = { title: "Import connections", properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] };
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const file = picked.filePaths[0];
    if (picked.canceled || !file) return null;
    let document: unknown;
    try {
      document = JSON.parse(await readFile(file, "utf-8"));
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const result = await connections.importConnections(document);
    connectionsChanged();
    return { path: file, ...result };
  });
  ipcMain.handle(IpcChannel.ConfigReveal, () => shell.showItemInFolder(config.filePath));

  // The workspace (folders open in the Explorer) — shared by the shell, the Search view and plugins.
  ipcMain.handle(IpcChannel.WorkspaceFolders, () => workspace.folders());
  ipcMain.handle(IpcChannel.WorkspaceAddFolder, (_e, path: unknown) => {
    if (typeof path !== "string" || !path.trim()) throw new Error("Choose a folder.");
    return workspace.addFolder(path);
  });
  ipcMain.handle(IpcChannel.RevealPath, (_e, path: unknown) => {
    // Only paths inside the workspace: a page can't make the shell open arbitrary locations.
    if (typeof path === "string" && (workspace.locate(path) || workspace.folders().some((f) => f.path === path))) shell.showItemInFolder(path);
  });
  ipcMain.handle(IpcChannel.WorkspaceRemoveFolder, (_e, id: unknown) => {
    if (typeof id === "string") workspace.removeFolder(id);
  });
  ipcMain.handle(IpcChannel.WorkspaceOpen, (_e, path: unknown, options: unknown) => {
    if (typeof path !== "string") throw new Error("A file path is required.");
    const o = (options ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return openWorkspaceFile(path, { line: num(o.line), column: num(o.column), length: num(o.length) });
  });

  // Title bar menus.
  const windowOf = (event: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender) ?? dialogParent();
  ipcMain.handle(IpcChannel.WindowAction, (event, action: WindowAction) => {
    const win = windowOf(event);
    const wc = win?.webContents;
    const zoom = (delta: number | null) => {
      if (!wc) return;
      const level = delta === null ? 0 : Math.max(-3, Math.min(5, wc.getZoomLevel() + delta));
      wc.setZoomLevel(level);
      views.setZoomLevel(level);
    };
    switch (action) {
      case "toggleDevTools":
        return wc?.toggleDevTools();
      case "toggleFullScreen":
        return win?.setFullScreen(!win.isFullScreen());
      case "zoomIn":
        return zoom(0.5);
      case "zoomOut":
        return zoom(-0.5);
      case "zoomReset":
        return zoom(null);
      case "reload":
        return wc?.reload();
      case "quit":
        return app.quit();
      case "revealConfigFolder":
        return void shell.openPath(dirname(config.filePath));
    }
  });
  ipcMain.handle(IpcChannel.EditAction, (event, role: EditRole, instanceId?: string) => {
    const wc = (instanceId ? views.webContentsOf(instanceId) : undefined) ?? event.sender;
    if (!["undo", "redo", "cut", "copy", "paste", "selectAll"].includes(role)) return;
    if (instanceId) wc.focus();
    wc[role]();
  });
  ipcMain.handle(IpcChannel.ViewSendKey, (_e, instanceId: string, key: ViewKey) => {
    const wc = views.webContentsOf(String(instanceId));
    if (!wc || typeof key?.key !== "string") return;
    const modifiers = [key.ctrl ? "control" : null, key.shift ? "shift" : null, key.alt ? "alt" : null].filter((m): m is "control" | "shift" | "alt" => m !== null);
    wc.focus();
    wc.sendInputEvent({ type: "keyDown", keyCode: key.key, modifiers });
    if (key.key.length === 1 && !key.ctrl && !key.alt) wc.sendInputEvent({ type: "char", keyCode: key.key, modifiers });
    wc.sendInputEvent({ type: "keyUp", keyCode: key.key, modifiers });
  });
  ipcMain.handle(IpcChannel.AppInfo, (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node,
    v8: process.versions.v8,
    platform: `${process.platform} ${process.arch}`,
    configDir: dirname(config.filePath),
  }));
  ipcMain.handle(IpcChannel.TitleBarColors, (event, background: string, foreground: string) => {
    const win = windowOf(event);
    if (!win || process.platform === "darwin" || typeof background !== "string" || typeof foreground !== "string") return;
    try {
      win.setTitleBarOverlay({ color: background, symbolColor: foreground });
    } catch {
      // the window was created without an overlay (e.g. a native frame) — nothing to recolour
    }
  });
  for (const win of getWindows()) {
    win.on("enter-full-screen", () => win.webContents.send(IpcChannel.FullScreenChanged, true));
    win.on("leave-full-screen", () => win.webContents.send(IpcChannel.FullScreenChanged, false));
  }

  ipcMain.handle(
    IpcChannel.ExplorerGetChildren,
    async (_event, connectionId: string, node: TreeNode | null): Promise<TreeNode[]> => {
      // A workspace folder: core's Explorer lists it.
      if (workspace.has(connectionId)) return workspace.children(connectionId, node);
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
        // One provider often owns several root node types and returns all of its
        // roots for `getChildren(null)` — drop the repeats from the fan-out.
        const seen = new Set<string>();
        return (results.flat() as TreeNode[]).filter((n) => {
          const key = `${n.nodeType}\u0000${n.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      return supervisor.invoke(pluginId, "explorer", node.nodeType, "getChildren", [node], connectionId) as Promise<
        TreeNode[]
      >;
    },
  );

  ipcMain.handle(
    IpcChannel.ViewOpen,
    async (
      _event,
      instanceId: string,
      pluginId: string,
      viewId: string,
      connectionId?: string,
      params?: Record<string, string>,
    ) => {
      if (pluginId === CORE_PLUGIN_ID) {
        const url = coreViewUrl(viewId);
        if (!url) throw new Error(`No core view "${viewId}".`);
        views.open({ instanceId, pluginId, viewId, connectionId, params, url });
        return;
      }
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
        params,
        entryDir: join(record.rootDir, record.manifest.ui),
        entryFile: viewContribution.entry,
      });
    },
  );

  ipcMain.handle(IpcChannel.DialogPickDirectory, async (event, defaultPath?: string): Promise<string | null> => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"], defaultPath };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IpcChannel.ViewClose, (_event, instanceId: string) => {
    const instance = views.getInstance(instanceId);
    views.close(instanceId);
    if (instance?.pluginId === CORE_PLUGIN_ID) {
      if (instance.viewId === TERMINAL_VIEW) terminal.viewGone();
    } else if (instance) supervisor.sendViewDispose(instance.pluginId, instance.viewId, instance.connectionId);
  });

  ipcMain.handle(IpcChannel.ViewSetBounds, (_event, instanceId: string, bounds: ViewBounds) => {
    views.setBounds(instanceId, bounds);
  });
}
