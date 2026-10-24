import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ThemeState, TreeNode } from "@oneclient/plugin-api";
import { type AppInfo, type GitMethod, IpcChannel } from "../shared/ipc-contract.js";
import type { ConnectionSummary, ContributionRegistrySnapshot, PluginSummary } from "../shared/types.js";
import type { ConfigStore } from "../config/config-store.js";
import type { ConnectionManager } from "../connections/connection-manager.js";
import type { ExtensionHostSupervisor } from "../plugins/extension-host-supervisor.js";
import type { PluginManager } from "../plugins/plugin-manager.js";
import type { ContributionRegistry } from "../plugins/registry.js";
import type { ThemeService } from "../themes/theme-service.js";
import type { SearchService } from "../search/search-service.js";
import type { OutputService } from "../output/output-service.js";
import type { ViewHost } from "../views/view-host.js";
import type { WorkspaceService } from "../workspace/workspace-service.js";
import { TERMINAL_VIEW, type TerminalService } from "../terminal/terminal-service.js";
import type { TaskService } from "../tasks/task-service.js";
import type { TaskRunner } from "../tasks/task-runner.js";
import type { GitService } from "../git/git-service.js";
import type { Platform } from "../platform/platform.js";
import type { RpcHost } from "./rpc-host.js";
import { CORE_PLUGIN_ID } from "../shared/core.js";
import { FILE_EDITORS_POINT, LEGACY_FILE_EDITORS_POINT } from "@oneclient/plugin-api";

/** Native file dialogs — the desktop app has them; in the web the browser picks/downloads the file instead. */
export interface FileDialogs {
  save(caller: unknown, options: { title: string; defaultName: string }): Promise<string | null>;
  open(caller: unknown, options: { title: string }): Promise<string | null>;
}

export interface IpcDeps {
  rpc: RpcHost;
  platform: Platform;
  themes: ThemeService;
  registry: ContributionRegistry;
  pluginManager: PluginManager;
  connections: ConnectionManager;
  search: SearchService;
  config: ConfigStore;
  supervisor: ExtensionHostSupervisor;
  views: ViewHost;
  output: OutputService;
  ensureActivated: (pluginId: string) => Promise<void>;
  workspace: WorkspaceService;
  /** Commands core implements itself (files.*, terminal.*), by id. */
  coreCommands: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  /** Page of a core view (file editor, terminal, diff) in the renderer build, or undefined for an unknown id. */
  coreViewPage: (viewId: string) => string | undefined;
  terminal: TerminalService;
  tasks: TaskService;
  taskRunner: TaskRunner;
  gitService: GitService;
  /** Opens a workspace file in the shell's editor (shared with plugins' context.workspace.openFile). */
  openWorkspaceFile: (path: string, options?: { line?: number | undefined; column?: number | undefined; length?: number | undefined }) => Promise<void>;
  dialogs?: FileDialogs;
}

/**
 * Every handler the shell and views use, the same in both runtimes (desktop: electron-handlers.ts adds the window,
 * dialog and native-view ones; web: server/server-handlers.ts adds its own), and the events broadcast to every shell.
 */
export function registerIpcHandlers(deps: IpcDeps): void {
  const { rpc, platform, registry, pluginManager, connections, search, config, supervisor, views, output, ensureActivated, themes, workspace, openWorkspaceFile, coreCommands, coreViewPage, terminal, tasks, taskRunner, gitService } = deps;
  const broadcast = (channel: string, payload: unknown) => rpc.broadcast(channel, payload);

  // Every add / remove — from the UI, an import or a plugin (context.connections.create) — reaches the shell.
  connections.onChanged(() => broadcast(IpcChannel.ConnectionsChanged, connections.list()));

  // Themes: shell gets the full state; every Tier 2 view gets it too (it applies the CSS variables).
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
  rpc.handle(IpcChannel.ThemeGetState, () => themes.getState());
  rpc.handle("oneclient-view:get-theme", () => forViews(themes.getState()));

  // Plugin-to-plugin extension points: views read what other plugins contributed (see ViewHostApi.getContributions).
  rpc.handle("oneclient-view:get-contributions", (_e, point: unknown) => {
    if (typeof point !== "string") return [];
    // The file editor's point was "oneclient-files.editors" while the editor lived in a plugin; plugins may still use it.
    if (point === FILE_EDITORS_POINT || point === LEGACY_FILE_EDITORS_POINT) return [...registry.getExtensions(FILE_EDITORS_POINT), ...registry.getExtensions(LEGACY_FILE_EDITORS_POINT)];
    return registry.getExtensions(point);
  });
  rpc.handle(IpcChannel.ThemeListColor, () => themes.listColorThemes());
  rpc.handle(IpcChannel.ThemeListIcon, () => themes.listIconThemes());
  rpc.handle(IpcChannel.ThemeSetColor, (_e, id: string, persist: boolean) => themes.setColorTheme(id, persist));
  rpc.handle(IpcChannel.ThemeSetIcon, (_e, id: string, persist: boolean) => themes.setIconTheme(id, persist));

  registry.onChanged((snapshot: ContributionRegistrySnapshot) => broadcast(IpcChannel.RegistryChanged, snapshot));
  pluginManager.on("changed", (summaries: PluginSummary[]) => broadcast(IpcChannel.PluginsChanged, summaries));
  views.onDirtyChanged((instanceId, dirty) => broadcast(IpcChannel.ViewDirtyChanged, { instanceId, dirty }));
  views.onShortcut((shortcut) => broadcast(IpcChannel.Shortcut, shortcut));
  views.onReveal((pluginId, viewId) => broadcast(IpcChannel.RevealView, { pluginId, viewId }));
  // Output panel: snapshot on demand, then live entries/clears/reveals.
  rpc.handle(IpcChannel.OutputList, () => output.snapshot());
  rpc.handle(IpcChannel.OutputClear, (_e, channelId: string) => output.clear(String(channelId)));
  output.onEntry((channel, entry) => broadcast(IpcChannel.OutputEntry, { channel, entry }));
  output.onCleared((channelId) => broadcast(IpcChannel.OutputCleared, channelId));
  output.onReveal((channelId) => broadcast(IpcChannel.OutputReveal, channelId));

  views.onRefreshExplorer((connectionId) => broadcast(IpcChannel.ExplorerRefresh, connectionId));
  views.onOpenView((pluginId, connectionId, request) => broadcast(IpcChannel.OpenViewRequest, { pluginId, connectionId, ...request }));

  rpc.handle(IpcChannel.RegistryGet, () => registry.snapshot());

  rpc.handle(IpcChannel.PluginList, (): PluginSummary[] =>
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

  rpc.handle(IpcChannel.PluginSetEnabled, async (_event, pluginId: string, enabled: boolean) => {
    pluginManager.setEnabled(pluginId, enabled);
    if (!enabled) await supervisor.deactivate(pluginId);
  });

  rpc.handle(IpcChannel.CommandExecute, async (_event, commandId: string, args: unknown[] = []) => {
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

  rpc.handle(IpcChannel.ConnectionList, (): ConnectionSummary[] => connections.list());
  rpc.handle(IpcChannel.ConnectionGetForm, (_event, typeId: string) => connections.getFormInfo(typeId));
  rpc.handle(IpcChannel.ConnectionTest, (_event, typeId: string, config: Record<string, unknown>) => connections.test(typeId, config));
  rpc.handle(IpcChannel.ConnectionCreate, (_event, typeId: string, name: string, config: Record<string, unknown>) => connections.create(typeId, name, config));
  rpc.handle(IpcChannel.ConnectionDelete, async (_event, id: string) => {
    await connections.delete(id);
  });

  // Global search: which providers exist, then one provider at a time (results stream in as each answers).
  rpc.handle(IpcChannel.SearchProviders, () => search.providers());
  rpc.handle(IpcChannel.SearchRun, (_e, providerId: string, query: string) => search.run(String(providerId), String(query)));

  // Export / import saved connections (JSON). The desktop app writes/reads the file itself (native dialogs); the web
  // gets the document back to download, and sends the uploaded document in.
  rpc.handle(IpcChannel.ConnectionExport, async (caller, includeSecrets: boolean) => {
    const document = await connections.exportConnections(includeSecrets === true);
    const summary = { count: document.connections.length, includesSecrets: document.includesSecrets };
    if (!deps.dialogs) return { path: "oneclient-connections.json", ...summary, document };
    const path = await deps.dialogs.save(caller, { title: includeSecrets ? "Export connections (with passwords)" : "Export connections", defaultName: "oneclient-connections.json" });
    if (!path) return null;
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf-8", mode: includeSecrets ? 0o600 : 0o644 });
    return { path, ...summary };
  });
  rpc.handle(IpcChannel.ConnectionImport, async (caller, uploaded?: { name?: unknown; document?: unknown }) => {
    let path: string;
    let document: unknown;
    if (uploaded && typeof uploaded === "object" && "document" in uploaded) {
      path = typeof uploaded.name === "string" ? uploaded.name : "the uploaded file";
      document = uploaded.document;
    } else {
      const file = await deps.dialogs?.open(caller, { title: "Import connections" });
      if (!file) return null;
      path = file;
      try {
        document = JSON.parse(await readFile(file, "utf-8"));
      } catch (err) {
        throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const result = await connections.importConnections(document);
    return { path, ...result };
  });

  // The workspace (folders open in the Explorer) — shared by the shell, the Search view and plugins.
  rpc.handle(IpcChannel.WorkspaceFolders, () => workspace.folders());
  rpc.handle(IpcChannel.WorkspaceAddFolder, (_e, path: unknown) => {
    if (typeof path !== "string" || !path.trim()) throw new Error("Choose a folder.");
    return workspace.addFolder(path);
  });
  rpc.handle(IpcChannel.WorkspaceRemoveFolder, (_e, id: unknown) => {
    if (typeof id === "string") workspace.removeFolder(id);
  });
  rpc.handle(IpcChannel.WorkspaceOpen, (_e, path: unknown, options: unknown) => {
    if (typeof path !== "string") throw new Error("A file path is required.");
    const o = (options ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return openWorkspaceFile(path, { line: num(o.line), column: num(o.column), length: num(o.length) });
  });

  // Background tasks and the Task Runner.
  tasks.onChanged((list) => broadcast(IpcChannel.TasksChanged, list));
  tasks.onOutput((id, chunk) => broadcast(IpcChannel.TaskOutputChunk, { id, chunk }));
  rpc.handle(IpcChannel.TasksList, () => tasks.list());
  rpc.handle(IpcChannel.TaskOutput, (_e, id: unknown) => (typeof id === "string" ? tasks.output(id) : ""));
  rpc.handle(IpcChannel.TaskCancel, (_e, id: unknown) => typeof id === "string" && tasks.cancel(id));
  rpc.handle(IpcChannel.TasksClear, () => tasks.clearFinished());
  rpc.handle(IpcChannel.TaskDefinitions, () => taskRunner.detect());
  rpc.handle(IpcChannel.TaskRun, (_e, definitionId: unknown) => {
    if (typeof definitionId !== "string") throw new Error("Which task?");
    return taskRunner.run(definitionId);
  });

  // Source control.
  gitService.onChanged((repos) => broadcast(IpcChannel.GitChanged, repos));
  rpc.handle(IpcChannel.GitRepos, () => gitService.list());
  const GIT_METHODS = new Set<GitMethod>(["refresh", "stage", "stageAll", "unstage", "unstageAll", "discard", "commit", "refs", "checkout", "createBranch", "deleteBranch", "fetch", "pull", "push", "sync", "init", "log", "commitFiles", "commitDetails"]);
  rpc.handle(IpcChannel.GitCall, (_e, method: GitMethod, args: unknown[]) => {
    if (!GIT_METHODS.has(method)) throw new Error(`Unknown git operation "${String(method)}".`);
    const fn = gitService[method] as (...a: unknown[]) => Promise<unknown>;
    return fn.apply(gitService, Array.isArray(args) ? args : []);
  });

  rpc.handle(IpcChannel.AppInfo, (): AppInfo => ({
    version: platform.appVersion,
    ...platform.versions,
    platform: `${process.platform} ${process.arch}`,
    configDir: dirname(config.filePath),
    runtime: platform.runtime,
  }));

  rpc.handle(IpcChannel.ExplorerGetChildren, async (_event, connectionId: string, node: TreeNode | null): Promise<TreeNode[]> => {
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
      const results = await Promise.all(rootNodeTypes.map((nodeType) => supervisor.invoke(pluginId, "explorer", nodeType, "getChildren", [null], connectionId)));
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

    return supervisor.invoke(pluginId, "explorer", node.nodeType, "getChildren", [node], connectionId) as Promise<TreeNode[]>;
  });

  rpc.handle(IpcChannel.ViewOpen, async (caller, instanceId: string, pluginId: string, viewId: string, connectionId?: string, params?: Record<string, string>) => {
    if (pluginId === CORE_PLUGIN_ID) {
      const corePage = coreViewPage(viewId);
      if (!corePage) throw new Error(`No core view "${viewId}".`);
      return views.open({ instanceId, pluginId, viewId, connectionId, params, corePage }, caller);
    }
    const viewContribution = registry.snapshot().views.find((v) => v.id === viewId && v.pluginId === pluginId);
    if (!viewContribution?.entry) throw new Error(`No Tier 2 view "${viewId}" contributed by "${pluginId}".`);

    const record = pluginManager.getRecord(pluginId);
    if (!record?.manifest.ui) throw new Error(`Plugin "${pluginId}" has no "ui" bundle declared in its manifest.`);

    await ensureActivated(pluginId);
    if (connectionId) await connections.ensureConnected(connectionId);

    return views.open({ instanceId, pluginId, viewId, connectionId, params, entryDir: join(record.rootDir, record.manifest.ui), entryFile: viewContribution.entry }, caller);
  });

  rpc.handle(IpcChannel.ViewClose, (caller, instanceId: string) => views.close(instanceId, caller));
  // Closed by the shell, or its browser tab went away: let the view's backend know.
  views.onInstanceClosed((instance) => {
    if (instance.pluginId === CORE_PLUGIN_ID) {
      // Shells keep running for the next Terminal panel — unless another window / tab still shows one.
      if (instance.viewId === TERMINAL_VIEW && !views.hasInstance(TERMINAL_VIEW)) terminal.viewGone();
    } else supervisor.sendViewDispose(instance.pluginId, instance.viewId, instance.connectionId);
  });
}
