import type { SearchHit, SearchOutcome, SearchProviderInfo } from "../search/search-service.js";
import type { TaskInfo } from "../tasks/task-service.js";
import type { TaskDefinition } from "../tasks/task-runner.js";
import type { RepoState } from "../git/git-service.js";
import type { Change, ChangeStatus, Commit, Ref } from "../git/git.js";
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
  ConnectionGetForEdit: "oneclient:connection:getForEdit",
  ConnectionUpdate: "oneclient:connection:update",
  ConnectionTestExisting: "oneclient:connection:testExisting",
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
  /** A view asked to re-fetch its connection's explorer tree. */
  ExplorerRefresh: "oneclient:explorer:refresh",

  OutputList: "oneclient:output:list",
  OutputEntry: "oneclient:output:entry",
  OutputCleared: "oneclient:output:cleared",
  OutputReveal: "oneclient:output:reveal",
  OutputClear: "oneclient:output:clear",

  SearchProviders: "oneclient:search:providers",
  SearchRun: "oneclient:search:run",

  WorkspaceFolders: "oneclient:workspace:folders",
  WorkspaceOpen: "oneclient:workspace:open",
  WorkspaceOpenFile: "oneclient:workspace:open-file",
  WorkspaceAddFolder: "oneclient:workspace:add-folder",
  WorkspaceRemoveFolder: "oneclient:workspace:remove-folder",
  WorkspaceChanged: "oneclient:workspace:changed",
  RevealPath: "oneclient:shell:reveal-path",

  TasksList: "oneclient:tasks:list",
  TasksChanged: "oneclient:tasks:changed",
  TaskOutput: "oneclient:tasks:output",
  TaskOutputChunk: "oneclient:tasks:output-chunk",
  TaskCancel: "oneclient:tasks:cancel",
  TasksClear: "oneclient:tasks:clear",
  TaskDefinitions: "oneclient:tasks:definitions",
  TaskRun: "oneclient:tasks:run",

  GitRepos: "oneclient:git:repos",
  GitChanged: "oneclient:git:changed",
  GitCall: "oneclient:git:call",

  WindowAction: "oneclient:window:action",
  EditAction: "oneclient:window:edit",
  ViewSendKey: "oneclient:view:send-key",
  AppInfo: "oneclient:app:info",
  TitleBarColors: "oneclient:window:titlebar-colors",
  FullScreenChanged: "oneclient:window:fullscreen",

  ConnectionExport: "oneclient:connection:export",
  ConnectionImport: "oneclient:connection:import",
  ConfigReveal: "oneclient:config:reveal",

  DialogPickDirectory: "oneclient:dialog:pickDirectory",
  DialogPickFile: "oneclient:dialog:pickFile",

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
export type WorkbenchShortcut =
  | "togglePanel"
  | "commandPalette"
  | "quickSearch"
  | "findInFiles"
  | "showExplorer"
  | "showScm"
  | "runBuildTask"
  | "toggleSidebar"
  | "closeEditor"
  | "nextEditor"
  | "previousEditor"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "toggleFullScreen";
export type { SearchHit, SearchOutcome, SearchProviderInfo };
export type { TaskInfo, TaskDefinition, RepoState, Change, ChangeStatus, Commit, Ref };

/** Git operations the Source Control view can call (GitService methods; the first argument is the repo root). */
export type GitMethod =
  | "refresh"
  | "stage"
  | "stageAll"
  | "unstage"
  | "unstageAll"
  | "discard"
  | "commit"
  | "refs"
  | "checkout"
  | "createBranch"
  | "deleteBranch"
  | "fetch"
  | "pull"
  | "push"
  | "sync"
  | "init"
  | "log"
  | "commitFiles"
  | "commitDetails";

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
export interface WorkspaceFolderInfo {
  id: string;
  name: string;
  /** Absolute path. */
  path: string;
}
export interface OpenWorkspaceFileEvent {
  folderId: string;
  /** "/"-separated path inside the folder. */
  relPath: string;
}
export type WindowAction = "toggleDevTools" | "toggleFullScreen" | "zoomIn" | "zoomOut" | "zoomReset" | "reload" | "quit" | "revealConfigFolder";
export type EditRole = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";
export interface ViewKey {
  /** Electron keyCode: "F", "F5", "Escape", "Enter"… */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}
export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  platform: string;
  configDir: string;
  /** "desktop" (the Electron app) or "web" (the self-hosted server, in a browser). */
  runtime: "desktop" | "web";
}

/** See OneClientApi.getConnectionForEdit. */
export interface ConnectionForEdit {
  id: string;
  name: string;
  typeId: string;
  pluginId: string;
  config: Record<string, unknown>;
  /** Secret fields with a stored value in this app (the desktop app and the web server keep their own). */
  savedSecrets: string[];
  missingSecrets: string[];
}

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
  /** A saved connection's settings for the edit form (never secrets), and which secrets this app has a value for. */
  getConnectionForEdit(id: string): Promise<ConnectionForEdit>;
  /** Saves new settings / name for a connection, keeping its id. Empty secret fields keep the stored value. */
  updateConnection(id: string, name: string, config: Record<string, unknown>): Promise<ConnectionSummary>;
  /** Tests edited settings; empty secret fields use the connection's stored ones. */
  testExistingConnection(id: string, config: Record<string, unknown>): Promise<ConnectionTestResult>;

  /** Global search: the providers plugins declared, then the hits of one provider for a query. */
  searchProviders(): Promise<SearchProviderInfo[]>;
  runSearch(providerId: string, query: string): Promise<SearchOutcome>;

  /** Save the connections to a JSON file the user picks. Passwords are only included when asked (then in plain text). Null = cancelled. */
  exportConnections(includeSecrets: boolean): Promise<{ path: string; count: number; includesSecrets: boolean; document?: unknown } | null>;
  /** Pick a JSON file (an export, or another oneclient.json) and add its connections. Null = cancelled. */
  importConnections(): Promise<{ path: string; added: number; skipped: number; invalid: number; withoutSecrets: number; warnings: string[] } | null>;
  /** Show ~/.oneclient/oneclient.json in the file manager. */
  revealConfigFile(): Promise<void>;

  /** The folders open in the Explorer (core's workspace). */
  workspaceFolders(): Promise<WorkspaceFolderInfo[]>;
  /** Open a folder in the Explorer (returns it; an already open one is returned as is). */
  addWorkspaceFolder(path: string): Promise<WorkspaceFolderInfo>;
  /** Close a folder (forget it — nothing on disk changes). */
  removeWorkspaceFolder(id: string): Promise<void>;
  onWorkspaceChanged(listener: (folders: WorkspaceFolderInfo[]) => void): () => void;
  /** Show a file or folder in the OS file manager. */
  revealPath(path: string): Promise<void>;

  /** Background tasks (Git, Task Runner, plugins). */
  listTasks(): Promise<TaskInfo[]>;
  onTasksChanged(listener: (tasks: TaskInfo[]) => void): () => void;
  taskOutput(id: string): Promise<string>;
  onTaskOutput(listener: (event: { id: string; chunk: string }) => void): () => void;
  cancelTask(id: string): Promise<boolean>;
  clearFinishedTasks(): Promise<void>;
  /** Task Runner: runnable tasks found in the open folders. */
  taskDefinitions(): Promise<TaskDefinition[]>;
  /** Starts (or restarts) a task definition; resolves to the task id. */
  runTask(definitionId: string): Promise<string>;

  /** Source control: the repositories of the open folders. */
  gitRepos(): Promise<RepoState[]>;
  onGitChanged(listener: (repos: RepoState[]) => void): () => void;
  git(method: GitMethod, ...args: unknown[]): Promise<unknown>;
  /** Open a workspace file (absolute path) in the editor, optionally revealing a line. Rejects if it's outside every open folder. */
  openWorkspaceFile(path: string, options?: { line?: number; column?: number; length?: number }): Promise<void>;
  /** Core asks the shell to open a file's editor tab (from openWorkspaceFile / a plugin's workspace.openFile). */
  onOpenWorkspaceFile(listener: (event: OpenWorkspaceFileEvent) => void): () => void;

  /** Title bar menus: window-level actions. */
  windowAction(action: WindowAction): Promise<void>;
  /** Edit menu: run an edit command in a Tier 2 view (by instance id) or, without one, in the shell itself. */
  editAction(role: EditRole, instanceId?: string): Promise<void>;
  /** Forward a key press to a Tier 2 view (menu items like Find, Go to Line, Run send the view its own shortcut). */
  sendKeyToView(instanceId: string, key: ViewKey): Promise<void>;
  appInfo(): Promise<AppInfo>;
  /** Colours of the native window buttons drawn over the custom title bar (Windows / Linux). */
  setTitleBarColors(background: string, foreground: string): Promise<void>;
  onFullScreenChanged(listener: (fullScreen: boolean) => void): () => void;

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
  onExplorerRefresh(listener: (connectionId: string) => void): () => void;

  /** The Output panel: every channel with its buffered entries, then live updates. */
  getOutput(): Promise<OutputChannelState[]>;
  onOutputEntry(listener: (event: { channel: OutputChannelInfo; entry: OutputEntry }) => void): () => void;
  onOutputCleared(listener: (channelId: string) => void): () => void;
  /** A plugin asked to show a channel (`OutputChannel.show()`). */
  onOutputReveal(listener: (channelId: string) => void): () => void;
  clearOutput(channelId: string): Promise<void>;

  /** Native "select folder" dialog; resolves to the chosen absolute path, or null if cancelled. */
  pickDirectory(defaultPath?: string): Promise<string | null>;
  /** Native "open file" dialog (a listing of the server's files in the web app); `extensions` are without the dot, e.g. ["csv", "tsv"]. Resolves to the chosen absolute path, or null. */
  pickFile(options?: { defaultPath?: string; extensions?: string[] }): Promise<string | null>;

  getThemeState(): Promise<ThemeState>;
  onThemeChanged(listener: (state: ThemeState) => void): () => void;
  listColorThemes(): Promise<ThemeListItem[]>;
  listIconThemes(): Promise<ThemeListItem[]>;
  /** `persist: false` previews without saving (theme picker). */
  setColorTheme(id: string, persist?: boolean): Promise<void>;
  setIconTheme(id: string, persist?: boolean): Promise<void>;
}
