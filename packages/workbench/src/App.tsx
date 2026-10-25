import { useEffect, useMemo, useRef, useState } from "react";
import type { TreeNode } from "@oneclient/plugin-api";
import type { SearchHit, WorkbenchShortcut, WorkspaceFolderInfo } from "@oneclient/backend/shared/ipc-contract.js";
import type { ConnectionSummary, ContributionRegistrySnapshot, PluginSummary } from "@oneclient/backend/shared/types.js";
import { ActivityBar, type ViewContainerId } from "./components/ActivityBar.js";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette.js";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu.js";
import { Logo } from "./components/Logo.js";
import { AssetIcon } from "./components/AssetIcon.js";
import { ThemeIcon, useResourceIcon, useThemeState } from "./theme.js";
import { QuickSearch } from "./components/QuickSearch.js";
import { WelcomePage } from "./components/WelcomePage.js";
import { OUTPUT_PANEL_KEY, OUTPUT_VIEW, Panel, TASKS_PANEL_KEY, TASKS_VIEW, usePanel } from "./components/Panel.js";
import { OUTPUT_SELECT_EVENT, OUTPUT_SELECT_KEY } from "./components/OutputView.js";
import { usePrompts } from "./components/PromptDialogs.js";
import { evaluateWhen, type WhenContext } from "./when.js";
import type { MenuId } from "@oneclient/plugin-api";
import type { EditRole, ViewKey } from "@oneclient/backend/shared/ipc-contract.js";
import { NewConnectionDialog } from "./components/NewConnectionDialog.js";
import { connectionLabel } from "./connection-label.js";
import { PluginManagerPanel } from "./components/PluginManagerPanel.js";
import { Sidebar, stripCategory } from "./components/Sidebar.js";
import { Tier2ViewHost } from "./components/Tier2ViewHost.js";
import { SecondarySidebar, type SecondaryView, useSecondarySidebar } from "./components/SecondarySidebar.js";
import type { QuickActionContribution } from "@oneclient/plugin-api";
import { SearchView, type SearchViewHandle } from "./components/SearchView.js";
import { ExplorerView, FILE_NODE, FOLDER_NODE } from "./components/ExplorerView.js";
import { ScmView, type ScmActions } from "./components/ScmView.js";
import { TASKS_SELECT_EVENT, STATE_ICON } from "./components/TasksView.js";
import { NotificationBell } from "./components/NotificationCenter.js";
import { APP_CONTEXT_MENU_EVENT, type AppContextMenuRequest } from "./web/app-context-menu.js";
import type { NotificationAction } from "@oneclient/backend/shared/notifications.js";
import type { RepoState, TaskInfo } from "@oneclient/backend/shared/ipc-contract.js";
import { CORE_PLUGIN_ID } from "@oneclient/backend/shared/core.js";
import { type MenuItem, TitleBar, type TopMenu } from "./components/TitleBar.js";

type Tab =
  | { id: "welcome"; title: "Welcome"; kind: "welcome" }
  | { id: "plugin-manager"; title: "Plugins"; kind: "plugin-manager" }
  | { id: string; title: string; kind: "command-result"; result: unknown }
  | {
      id: string;
      title: string;
      kind: "tier2-view";
      instanceId: string;
      pluginId: string;
      viewId: string;
      connectionId?: string;
      params?: Record<string, string>;
      /** The tree node (file/folder) this tab was opened from — its icon is shown on the tab. */
      resource?: { name: string; kind: "file" | "folder" };
      /** A `$(id)` registry icon for tabs opened by a plugin view (ViewHostApi.openView). */
      icon?: string;
    };

const emptyRegistry: ContributionRegistrySnapshot = {
  connectionTypes: [],
  explorerNodes: [],
  explorerSections: [],
  views: [],
  commands: [],
  themes: [],
  iconThemes: [],
  searchProviders: [],
  icons: [],
  menus: [],
  quickActions: [],
  extensions: [],
};

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 260;
const SIDEBAR_STORAGE_KEY = "oneclient.sidebarWidth";
/** Must match `--activity-bar-width` in styles.css. */
const ACTIVITY_BAR_WIDTH = 48;

function useResizableSidebar() {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_STORAGE_KEY));
    return stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX ? stored : SIDEBAR_DEFAULT;
  });

  useEffect(() => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width));
  }, [width]);

  function startResizing(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const wrapper = handle.closest<HTMLElement>(".sidebar-wrapper");
    const app = wrapper?.parentElement;
    if (!wrapper || !app) return;
    // Pointer capture: the handle keeps getting the moves when the pointer crosses a view's iframe or leaves the window.
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("sidebar-resizing");
    let latest = width;
    let frame = 0;
    // During the drag only these two elements' styles change (not a CSS variable on the root, which would make the
    // browser re-resolve styles for the whole page), and React isn't involved: it learns the final width at the end.
    const apply = () => {
      frame = 0;
      app.style.gridTemplateColumns = `var(--activity-bar-width) ${latest}px 1fr`;
      wrapper.style.width = `${latest}px`;
    };
    const onMove = (ev: PointerEvent) => {
      latest = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX - ACTIVITY_BAR_WIDTH));
      if (!frame) frame = requestAnimationFrame(apply); // at most one layout per frame, however fast the mouse reports
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      if (frame) cancelAnimationFrame(frame);
      document.body.classList.remove("sidebar-resizing");
      setWidth(latest);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  return { width, startResizing };
}

const CONTAINER_STORAGE_KEY = "oneclient.activeViewContainer";

/** The integrated terminal: a core view in the bottom panel (first, before plugins' panel views). */
const TERMINAL_VIEW = { pluginId: CORE_PLUGIN_ID, id: "terminal.panel", title: "Terminal", tier: 2 as const, location: "panel" as const, entry: "", icon: "$(terminal)" };
/** Core's file editor (a file's tab). */
const EDITOR_VIEW_ID = "files.editor";

/** Activity-bar selection: which view container the sidebar shows, and whether the sidebar is open. */
function useViewContainer(explorerPlugins: PluginSummary[]) {
  const [active, setActive] = useState<ViewContainerId | null>(
    () => localStorage.getItem(CONTAINER_STORAGE_KEY) as ViewContainerId | null,
  );
  const [visible, setVisible] = useState(true);

  // Fall back to core's Explorer (on a fresh install) when nothing is remembered or the remembered one is gone.
  const known = (id: ViewContainerId | null) => id === "explorer" || id === "plugins" || id === "search" || id === "scm" || explorerPlugins.some((p) => `plugin:${p.id}` === id);
  const resolved: ViewContainerId = active !== null && known(active) ? active : "explorer";

  function select(id: ViewContainerId) {
    if (id === resolved) {
      setVisible((v) => !v);
      return;
    }
    setActive(id);
    setVisible(true);
    localStorage.setItem(CONTAINER_STORAGE_KEY, id);
  }

  /** Show a container (never toggles it closed) — menus and shortcuts like Ctrl+Shift+E. */
  function show(id: ViewContainerId) {
    setActive(id);
    setVisible(true);
    localStorage.setItem(CONTAINER_STORAGE_KEY, id);
  }

  return { active: resolved, visible, select, show, setVisible };
}

export function App() {
  const [registry, setRegistry] = useState<ContributionRegistrySnapshot>(emptyRegistry);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  // The Welcome tab can be closed; closing it keeps it closed on the next start (reopen it from the palette or the gear menu).
  const welcomeClosed = localStorage.getItem("oneclient.welcomeClosed") === "1";
  const [tabs, setTabs] = useState<Tab[]>(welcomeClosed ? [] : [{ id: "welcome", title: "Welcome", kind: "welcome" }]);
  const [activeTabId, setActiveTabId] = useState(welcomeClosed ? "" : "welcome");
  // Split editor: the tabs listed in `rightIds` form a second group beside the first (every other tab is in the left
  // group). All tabs stay in the one `tabs` list, so a view keeps running — and keeps its unsaved edits — when it moves
  // between groups. `activeTabId` is the left group's active tab.
  const [rightIds, setRightIds] = useState<string[]>([]);
  const [rightActiveId, setRightActiveId] = useState("");
  /** The group that Save, Close, the shortcuts and new tabs act on. */
  const [focusRight, setFocusRight] = useState(false);
  const [splitRatio, setSplitRatio] = useState(() => {
    const stored = Number(localStorage.getItem("oneclient.splitRatio"));
    return stored >= 0.2 && stored <= 0.8 ? stored : 0.5;
  });
  /** The tab being dragged between groups (shows the drop zones). */
  const [draggingTab, setDraggingTab] = useState<string | null>(null);
  const leftTabs = tabs.filter((t) => !rightIds.includes(t.id));
  const rightTabs = tabs.filter((t) => rightIds.includes(t.id));
  const split = rightTabs.length > 0;
  const leftActive = leftTabs.find((t) => t.id === activeTabId) ?? leftTabs[0];
  const rightActive = rightTabs.find((t) => t.id === rightActiveId) ?? rightTabs[0];
  /** The focused group's active tab: what the menus, Save and Close apply to. */
  const activeTab = focusRight && rightActive ? rightActive : leftActive;
  const sidebar = useResizableSidebar();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  /** Bumped per connection when a view asks for its explorer tree to be re-fetched. */
  const [explorerTokens, setExplorerTokens] = useState<Record<string, number>>({});
  /** A quick pick other than the command palette (theme pickers). */
  const [quickPick, setQuickPick] = useState<React.ComponentProps<typeof CommandPalette> | null>(null);
  const theme = useThemeState();
  // `null` pluginId = every connection type (command palette); otherwise just that plugin's.
  const [newConnectionFor, setNewConnectionFor] = useState<{ pluginId: string | null } | null>(null);
  const [editConnection, setEditConnection] = useState<ConnectionSummary | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  /** A title bar menu is open (its dropdown must not be covered by the native view layers). */
  const [menuBarOpen, setMenuBarOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  /** What the Edit menu acts on: the editor view or the shell element that had focus when the menu bar was clicked. */
  const editTarget = useRef<{ instanceId?: string; element?: HTMLElement | null }>({});
  const menuActionsRef = useRef({ newTerminal: () => {}, showPlugins: () => {}, showOutput: () => {}, newConnection: () => {}, newFile: () => {}, openFolder: () => {} });
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** Tier 2 view instances (= tab ids) that reported unsaved changes. */
  const [dirtyViews, setDirtyViews] = useState<Set<string>>(new Set());
  const prompts = usePrompts();
  // Tier 2 views are native layers drawn *over* this DOM, so hide them while
  // anything floating (menu, dialog, palette) is open or it'd be covered.
  const overlayOpen = paletteOpen || searchOpen || quickPick !== null || newConnectionFor !== null || menu !== null || menuBarOpen || prompts.element !== null;

  // Plugins that get an activity-bar explorer: anything not disabled/broken that contributes connection types.
  const explorerPlugins = useMemo(
    () =>
      plugins.filter(
        (p) => p.state !== "disabled" && p.state !== "invalid" && p.state !== "incompatible" && registry.connectionTypes.some((t) => t.pluginId === p.id),
      ),
    [plugins, registry.connectionTypes],
  );
  const container = useViewContainer(explorerPlugins);
  /** The folders open in the Explorer (core's workspace) — the Explorer, Search and the File menu use them. */
  const [folders, setFolders] = useState<WorkspaceFolderInfo[]>([]);
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  useEffect(() => {
    void window.oneclient.workspaceFolders().then(setFolders);
    return window.oneclient.onWorkspaceChanged(setFolders);
  }, []);
  /** Source control: the repositories of the open folders. */
  const [repos, setRepos] = useState<RepoState[]>([]);
  useEffect(() => {
    void window.oneclient.gitRepos().then(setRepos);
    return window.oneclient.onGitChanged(setRepos);
  }, []);
  /** The repository the user is working in: picked in Source Control, else the first one. */
  const [activeRepoRoot, setActiveRepoRoot] = useState<string | undefined>(() => localStorage.getItem("oneclient.scm.activeRepo") ?? undefined);
  const activeRepo = repos.find((r) => r.root === activeRepoRoot) ?? repos[0];
  const scmCount = repos.reduce((n, r) => n + r.staged.length + r.unstaged.length + r.untracked.length + r.conflicts.length, 0);
  /** Background tasks (status bar indicator). */
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  useEffect(() => {
    void window.oneclient.listTasks().then(setTasks);
    return window.oneclient.onTasksChanged(setTasks);
  }, []);
  const searchRef = useRef<SearchViewHandle>(null);
  const pickTaskRef = useRef<(group?: "build" | "test") => Promise<void>>(async () => {});
  const scmActionsRef = useRef<ScmActions>(null as unknown as ScmActions);
  const reposRef = useRef<RepoState[]>([]);
  const activeRepoRef = useRef<RepoState | undefined>(undefined);
  const [searchMounted, setSearchMounted] = useState(false);
  useEffect(() => {
    if (container.active === "search") setSearchMounted(true);
  }, [container.active]);

  // Bottom panel: every Tier 2 view contributed with location "panel" (e.g. the Terminal).
  const panelViews = useMemo(
    () => [
      TERMINAL_VIEW, // core's terminal first
      ...registry.views.filter((v) => v.tier === 2 && v.location === "panel"),
      TASKS_VIEW, // background tasks
      OUTPUT_VIEW, // the shell's own Output log, always last
    ],
    [registry.views],
  );
  const panel = usePanel(panelViews);
  const findInFilesRef = useRef<(replace?: boolean) => void>(() => {});
  /** Shortcuts, from the shell's own keydown or forwarded by a focused view (see WorkbenchShortcut). */
  const shortcutRef = useRef<(shortcut: WorkbenchShortcut) => void>(() => {});
  const panelToggleRef = useRef(panel.toggle);
  panelToggleRef.current = panel.toggle;
  const secondary = useSecondarySidebar();
  const secondaryToggleRef = useRef(secondary.toggle);
  secondaryToggleRef.current = secondary.toggle;
  const secondaryShowRef = useRef(secondary.show);
  secondaryShowRef.current = secondary.show;
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const panelRef = useRef(panel);
  panelRef.current = panel;

  useEffect(() => {
    void window.oneclient.getRegistry().then(setRegistry);
    void window.oneclient.listPlugins().then(setPlugins);
    void window.oneclient.listConnections().then(setConnections);

    const offRegistry = window.oneclient.onRegistryChanged(setRegistry);
    const offPlugins = window.oneclient.onPluginsChanged(setPlugins);
    const offConnections = window.oneclient.onConnectionsChanged(setConnections);
    const offDirty = window.oneclient.onViewDirtyChanged(({ instanceId, dirty }) =>
      setDirtyViews((prev) => {
        if (prev.has(instanceId) === dirty) return prev;
        const next = new Set(prev);
        if (dirty) next.add(instanceId);
        else next.delete(instanceId);
        return next;
      }),
    );
    // Same shortcuts, pressed while a Tier 2 view (editor, terminal) had keyboard focus.
    const offShortcut = window.oneclient.onShortcut((shortcut) => shortcutRef.current(shortcut));
    const offOpenFile = window.oneclient.onOpenWorkspaceFile(({ folderId, relPath }) => openWorkspaceFileRef.current(folderId, relPath));
    const offFullScreen = window.oneclient.onFullScreenChanged(setFullScreen);
    // A view revealing another view of its plugin — today that means a panel view (e.g. Query Results).
    // A plugin view asking for another of its views in a new tab (e.g. a table row → that row's editor).
    const offExplorerRefresh = window.oneclient.onExplorerRefresh((connectionId) => setExplorerTokens((prev) => ({ ...prev, [connectionId]: (prev[connectionId] ?? 0) + 1 })));
    const offOpenView = window.oneclient.onOpenViewRequest((e) => {
      if (e.pluginId === CORE_PLUGIN_ID && e.viewId === "git.diff") {
        const key = Object.entries(e.params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
        const id = `core:git.diff:${key}`;
        return openTab({ id, title: e.title, kind: "tier2-view", instanceId: id, pluginId: CORE_PLUGIN_ID, viewId: "git.diff", params: e.params, ...(e.icon ? { icon: e.icon } : {}) });
      }
      const contribution = registryRef.current.views.find((v) => v.pluginId === e.pluginId && v.id === e.viewId && v.tier === 2);
      if (!contribution) return;
      if (contribution.dock === "secondary") {
        return secondaryShowRef.current({ title: e.title, pluginId: e.pluginId, viewId: e.viewId, ...(e.connectionId ? { connectionId: e.connectionId } : {}), params: e.params, ...(e.icon ? { icon: e.icon } : {}) });
      }
      const key = Object.entries(e.params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      const instanceId = `${e.pluginId}:${e.viewId}:${e.connectionId ?? ""}:${key}`;
      openTab({
        id: instanceId,
        title: e.title,
        kind: "tier2-view",
        instanceId,
        pluginId: e.pluginId,
        viewId: e.viewId,
        ...(e.connectionId ? { connectionId: e.connectionId } : {}),
        params: e.params,
        ...(e.icon ? { icon: e.icon } : {}),
      });
    });
    // A plugin asked to show one of its Output channels.
    const offOutputReveal = window.oneclient.onOutputReveal((channelId) => {
      localStorage.setItem(OUTPUT_SELECT_KEY, channelId);
      window.dispatchEvent(new CustomEvent(OUTPUT_SELECT_EVENT, { detail: channelId }));
      panelRef.current.show(OUTPUT_PANEL_KEY, { focus: false });
    });
    const offReveal = window.oneclient.onRevealView(({ pluginId, viewId }) => {
      const key = `${pluginId}:${viewId}`;
      if (panelRef.current.views.some((v) => `${v.pluginId}:${v.id}` === key)) panelRef.current.show(key, { focus: false });
    });
    return () => {
      offRegistry();
      offOutputReveal();
      offPlugins();
      offConnections();
      offDirty();
      offShortcut();
      offReveal();
      offOpenView();
      offExplorerRefresh();
      offOpenFile();
      offFullScreen();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Typing in a text field keeps the editing keys (Ctrl+W, Ctrl+B… are fine; Ctrl+N/O aren't text keys either).
      let action: (() => void) | null = null;
      if (mod && e.shiftKey && key === "p") action = () => setPaletteOpen((v) => !v);
      else if (mod && e.shiftKey && !e.altKey && key === "f") action = () => findInFilesRef.current();
      else if (mod && e.shiftKey && !e.altKey && key === "h") action = () => findInFilesRef.current(true);
      else if (mod && !e.shiftKey && !e.altKey && key === "p") action = () => setSearchOpen((v) => !v);
      else if (mod && !e.shiftKey && (e.key === "`" || e.code === "Backquote")) action = () => panelToggleRef.current();
      else if (mod && e.shiftKey && e.code === "Backquote") action = () => menuActionsRef.current.newTerminal();
      else if (mod && e.shiftKey && !e.altKey && key === "e") action = () => shortcutRef.current("showExplorer");
      else if (mod && e.shiftKey && !e.altKey && key === "g") action = () => shortcutRef.current("showScm");
      else if (mod && e.shiftKey && !e.altKey && key === "b") action = () => shortcutRef.current("runBuildTask");
      else if (mod && e.shiftKey && !e.altKey && key === "x") action = () => menuActionsRef.current.showPlugins();
      else if (mod && e.shiftKey && !e.altKey && key === "u") action = () => menuActionsRef.current.showOutput();
      else if (mod && e.shiftKey && !e.altKey && key === "n") action = () => menuActionsRef.current.newConnection();
      else if (mod && !e.shiftKey && !e.altKey && key === "n") action = () => menuActionsRef.current.newFile();
      else if (mod && !e.shiftKey && !e.altKey && key === "o") action = () => menuActionsRef.current.openFolder();
      else if (mod && !e.shiftKey && !e.altKey && key === "b") action = () => shortcutRef.current("toggleSidebar");
      else if (mod && !e.shiftKey && e.altKey && key === "b") action = () => secondaryToggleRef.current();
      else if (mod && !e.shiftKey && !e.altKey && key === "w") action = () => shortcutRef.current("closeEditor");
      else if (mod && !e.altKey && e.key === "PageDown") action = () => shortcutRef.current("nextEditor");
      else if (mod && !e.altKey && e.key === "PageUp") action = () => shortcutRef.current("previousEditor");
      else if (mod && !e.altKey && (e.key === "=" || e.key === "+")) action = () => shortcutRef.current("zoomIn");
      else if (mod && !e.altKey && e.key === "-") action = () => shortcutRef.current("zoomOut");
      else if (mod && !e.altKey && e.key === "0") action = () => shortcutRef.current("zoomReset");
      else if (!mod && !e.altKey && e.key === "F11") action = () => shortcutRef.current("toggleFullScreen");
      else if (mod && e.shiftKey && !e.altKey && key === "i") action = () => void window.oneclient.windowAction("toggleDevTools");
      if (!action) return;
      e.preventDefault();
      action();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Switching to a plugin tab gives its view keyboard focus — so typing goes to it, and it learns
  // it's the active one (e.g. the query editor tells Query Results which window's results to show).
  useEffect(() => {
    if (activeTab?.kind !== "tier2-view") return;
    const instanceId = activeTab.instanceId;
    const timer = setTimeout(() => void window.oneclient.focusView(instanceId), 80);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id]);

  // Clicking inside a view's iframe doesn't reach the shell, but the page loses focus to the iframe: that tells which
  // group the click was in, so Save, Close and the shortcuts then act on that group.
  useEffect(() => {
    const onBlur = () =>
      setTimeout(() => {
        const el = document.activeElement;
        if (!(el instanceof HTMLIFrameElement)) return;
        const group = el.closest<HTMLElement>(".tier2-slot")?.dataset.group;
        if (group) setFocusRight(group === "right");
      }, 0);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  function openWelcome() {
    localStorage.removeItem("oneclient.welcomeClosed");
    openTab({ id: "welcome", title: "Welcome", kind: "welcome" });
  }

  function importConnections() {
    void window.oneclient
      .importConnections()
      .then((r) => {
        if (!r) return;
        const parts = [`Imported ${r.added} connection${r.added === 1 ? "" : "s"}`];
        if (r.skipped) parts.push(`${r.skipped} already existed`);
        if (r.invalid) parts.push(`${r.invalid} invalid skipped`);
        if (r.withoutSecrets) parts.push(`${r.withoutSecrets} need their password entered`);
        pushToast(r.added > 0 ? "info" : "error", `${parts.join(", ")}.`);
        for (const w of r.warnings.slice(0, 3)) pushToast("error", w);
      })
      .catch((err: unknown) => pushToast("error", `Import: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Shows a tab and gives its group the focus. */
  function activateTab(id: string) {
    if (rightIds.includes(id)) {
      setRightActiveId(id);
      setFocusRight(true);
    } else {
      setActiveTabId(id);
      setFocusRight(false);
    }
  }

  function openTab(tab: Tab) {
    if (tabs.some((t) => t.id === tab.id)) return activateTab(tab.id);
    setTabs((prev) => [...prev, tab]);
    // A new tab opens in the group that has the focus.
    if (focusRight && split) {
      setRightIds((prev) => [...prev, tab.id]);
      setRightActiveId(tab.id);
    } else {
      setActiveTabId(tab.id);
      setFocusRight(false);
    }
  }

  function closeTabs(ids: string[]) {
    const closing = new Set(ids);
    if (closing.has("welcome")) localStorage.setItem("oneclient.welcomeClosed", "1");
    const leftBefore = tabs.filter((t) => !rightIds.includes(t.id));
    const rightBefore = tabs.filter((t) => rightIds.includes(t.id));
    const leftAfter = leftBefore.filter((t) => !closing.has(t.id));
    const rightAfter = rightBefore.filter((t) => !closing.has(t.id));
    // Like VS Code: closing a group's active tab focuses its neighbour, not the first tab.
    const neighbour = (before: Tab[], after: Tab[]) => after[Math.min(Math.max(0, before.findIndex((t) => closing.has(t.id))), after.length - 1)]?.id ?? "";
    setTabs(tabs.filter((t) => !closing.has(t.id)));
    setDirtyViews((prev) => new Set([...prev].filter((id) => !closing.has(id))));
    if (leftAfter.length === 0 && rightAfter.length > 0) {
      // The left group emptied: the right one takes its place.
      setActiveTabId(closing.has(rightActiveId) || !rightAfter.some((t) => t.id === rightActiveId) ? neighbour(rightBefore, rightAfter) : rightActiveId);
      setRightIds([]);
      setFocusRight(false);
      return;
    }
    if (closing.has(activeTabId)) setActiveTabId(neighbour(leftBefore, leftAfter));
    setRightIds(rightAfter.map((t) => t.id));
    if (rightAfter.length === 0) setFocusRight(false);
    else if (closing.has(rightActiveId)) setRightActiveId(neighbour(rightBefore, rightAfter));
  }

  /** Moves a tab to the right group (creating it) or back to the left one. The view isn't re-created: it keeps its state. */
  function moveTab(id: string, toRight: boolean) {
    const inRight = rightIds.includes(id);
    if (toRight === inRight || !tabs.some((t) => t.id === id)) return;
    if (toRight) {
      if (leftTabs.length < 2) return pushToast("info", "Open another editor first — a split needs a tab on each side.");
      const index = leftTabs.findIndex((t) => t.id === id);
      const rest = leftTabs.filter((t) => t.id !== id);
      if (id === leftActive?.id) setActiveTabId(rest[Math.min(index, rest.length - 1)]!.id);
      setRightIds((prev) => [...prev, id]);
      setRightActiveId(id);
      setFocusRight(true);
    } else {
      const rest = rightIds.filter((r) => r !== id);
      setRightIds(rest);
      if (rest.length && id === rightActive?.id) setRightActiveId(rest[rest.length - 1]!);
      setActiveTabId(id);
      setFocusRight(false);
    }
  }

  /** Closes tabs, asking first when some have unsaved changes. */
  async function closeWithConfirm(ids: string[], what: string) {
    if (ids.length === 0) return;
    const unsaved = ids.filter((id) => dirtyViews.has(id)).length;
    if (unsaved > 0) {
      const ok = await prompts.confirm({
        title: "Unsaved Changes",
        message: `${unsaved} editor(s) have unsaved changes. Close ${what} and discard them?`,
        confirmLabel: "Discard Changes",
        danger: true,
      });
      if (!ok) return;
    }
    closeTabs(ids);
  }

  /** Close Saved: every editor without unsaved changes (in both groups). */
  const closeSavedTabs = () => closeTabs(tabs.filter((t) => !dirtyViews.has(t.id)).map((t) => t.id));

  /** The menu of a tab (right-click) or of a group's "…" button: closing and moving editors. */
  function openEditorMenu(x: number, y: number, group: "left" | "right", tab: Tab | undefined) {
    const inGroup = group === "right" ? rightTabs : leftTabs;
    const index = tab ? inGroup.findIndex((t) => t.id === tab.id) : -1;
    const items: ContextMenuItem[] = [];
    if (tab) items.push({ id: "close", label: "Close", run: () => void requestCloseTab(tab.id) });
    if (tab) items.push({ id: "others", label: "Close Others", run: () => void closeWithConfirm(inGroup.filter((t) => t.id !== tab.id).map((t) => t.id), "the others") });
    if (tab) items.push({ id: "right", label: "Close to the Right", run: () => void closeWithConfirm(inGroup.slice(index + 1).map((t) => t.id), "the editors to the right") });
    items.push({ id: "saved", label: "Close Saved Editors", separator: items.length > 0, run: closeSavedTabs });
    items.push({ id: "all", label: "Close All Editors", run: () => void closeAllTabs() });
    const target = tab ?? (group === "right" ? rightActive : leftActive);
    if (target) {
      items.push(
        group === "right"
          ? { id: "move", label: "Move Editor to Left Group", separator: true, run: () => moveTab(target.id, false) }
          : { id: "move", label: "Split Editor Right", separator: true, run: () => moveTab(target.id, true) },
      );
    }
    if (target?.kind === "tier2-view") {
      items.push({ id: "dock", label: "Move to Secondary Side Bar", separator: true, run: () => dockTab(target) });
    }
    setMenu({ x, y, items });
  }

  /** Moves a view tab out of the editor into the secondary side bar (its state is reloaded there). */
  function dockTab(tab: Extract<Tab, { kind: "tier2-view" }>) {
    closeTabs([tab.id]);
    secondary.show({
      title: tab.title,
      pluginId: tab.pluginId,
      viewId: tab.viewId,
      ...(tab.connectionId ? { connectionId: tab.connectionId } : {}),
      ...(tab.params ? { params: tab.params } : {}),
      ...(tab.icon ? { icon: tab.icon } : {}),
      originId: tab.id,
    });
  }

  /** The Git Graph tab (a core view): one per window, any repository inside it. */
  function openGitGraph() {
    openTab({ id: "core:git.graph", title: "Git Graph", kind: "tier2-view", instanceId: "core:git.graph", pluginId: CORE_PLUGIN_ID, viewId: "git.graph", icon: "$(git-graph)" });
  }

  /** A plugin's title-bar quick action: run its command, or open its view (on its first connection; New Connection when it has none). */
  function runQuickAction(qa: QuickActionContribution & { pluginId: string }) {
    if (qa.command) return void runContributedCommand(qa.command, qa.title);
    const open = qa.openView;
    if (!open) return;
    const view = registry.views.find((v) => v.pluginId === qa.pluginId && v.id === open.viewId && v.tier === 2);
    if (!view) return pushToast("error", `${qa.title}: the view "${open.viewId}" is not available.`);
    let connection: ConnectionSummary | undefined;
    if (view.connectionType) {
      connection = connections.find((c) => c.pluginId === qa.pluginId && c.typeId === view.connectionType);
      if (!connection) return setNewConnectionFor({ pluginId: qa.pluginId });
    }
    const uid = `n${Date.now().toString(36)}`;
    const params = Object.fromEntries(Object.entries(open.params ?? {}).map(([k, v]) => [k, v.replaceAll("{uid}", uid)]));
    const title = open.title ?? view.title;
    if (view.dock === "secondary") {
      return secondary.show({ title, pluginId: qa.pluginId, viewId: view.id, ...(connection ? { connectionId: connection.id } : {}), params, ...(qa.icon ? { icon: qa.icon } : {}) });
    }
    const instanceId = `${qa.pluginId}:${view.id}:${connection?.id ?? ""}:${JSON.stringify(params)}`;
    openTab({ id: instanceId, title, kind: "tier2-view", instanceId, pluginId: qa.pluginId, viewId: view.id, ...(connection ? { connectionId: connection.id } : {}), params, ...(qa.icon ? { icon: qa.icon } : {}) });
  }

  /** Title-bar quick access: plugins' actions (by `order`), then Git Graph, then the layout toggles. */
  const quickAccess = (
    <>
      {[...registry.quickActions]
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        .map((qa) => (
          <button key={`${qa.pluginId}:${qa.id}`} className="qa-button" title={qa.title} aria-label={qa.title} onClick={() => runQuickAction(qa)}>
            <AssetIcon pluginId={qa.pluginId} icon={qa.icon ?? "$(extensions)"} size={16} />
          </button>
        ))}
      <button className="qa-button" title="Git Graph" aria-label="Git Graph" onClick={openGitGraph}>
        <ThemeIcon id="git-graph" size={16} />
      </button>
      <span className="qa-sep" />
      <button className={`qa-button ${container.visible ? "on" : ""}`} title="Toggle Primary Side Bar (Ctrl+B)" aria-label="Toggle Primary Side Bar" onClick={() => shortcutRef.current("toggleSidebar")}>
        <ThemeIcon id="layout-sidebar" size={16} />
      </button>
      <button className={`qa-button ${panel.open ? "on" : ""}`} title="Toggle Panel (Ctrl+`)" aria-label="Toggle Panel" onClick={() => panel.toggle()}>
        <ThemeIcon id="layout-panel" size={16} />
      </button>
      <button className={`qa-button ${secondary.open ? "on" : ""}`} title="Toggle Secondary Side Bar (Ctrl+Alt+B)" aria-label="Toggle Secondary Side Bar" onClick={() => secondary.toggle()}>
        <ThemeIcon id="secondary-sidebar" size={16} />
      </button>
    </>
  );

  /**
   * The one-click way to the AI assistant: its chat in the secondary side bar. Uses the AI connection (it holds all
   * the API keys); if there is none yet, opens the New Connection dialog for it.
   */
  function openAiChat() {
    const ai = connections.find((c) => c.pluginId === "oneclient-ai" && c.typeId === "ai");
    if (!ai) {
      if (!plugins.some((p) => p.id === "oneclient-ai" && p.state !== "disabled")) return pushToast("error", "The AI Assistant plugin is not enabled.");
      return setNewConnectionFor({ pluginId: "oneclient-ai" });
    }
    if (secondary.view?.pluginId === "oneclient-ai" && secondary.view.viewId === "ai.chat") return secondary.show(secondary.view);
    secondary.show({ title: "AI Chat", pluginId: "oneclient-ai", viewId: "ai.chat", connectionId: ai.id, params: { c: `n${Date.now().toString(36)}` }, icon: "icon.svg" });
  }

  /** Brings the secondary side bar's view back as an editor tab. */
  function undockView(view: SecondaryView) {
    secondary.clearView();
    const id = view.originId ?? `${view.pluginId}:${view.viewId}:${view.connectionId ?? ""}:${JSON.stringify(view.params ?? {})}`;
    openTab({
      id,
      title: view.title,
      kind: "tier2-view",
      instanceId: id,
      pluginId: view.pluginId,
      viewId: view.viewId,
      ...(view.connectionId ? { connectionId: view.connectionId } : {}),
      ...(view.params ? { params: view.params } : {}),
      ...(view.icon ? { icon: view.icon } : {}),
    });
    secondary.hide();
  }

  async function requestCloseTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (tab && dirtyViews.has(id)) {
      const discard = await prompts.confirm({
        title: "Unsaved Changes",
        message: `"${tab.title}" has unsaved changes. Close it and discard them?`,
        confirmLabel: "Discard Changes",
        danger: true,
      });
      if (!discard) return;
    }
    closeTabs([id]);
  }

  function pushToast(kind: Toast["kind"], message: string) {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }

  function openExplorerContextMenu(
    e: React.MouseEvent,
    connection: ConnectionSummary,
    node: TreeNode | undefined,
    refresh: () => void,
  ) {
    const ctx: WhenContext = node
      ? { contextValue: node.contextValue, nodeType: node.nodeType, connectionType: connection.typeId }
      : { contextValue: "connection", connectionType: connection.typeId };

    // Any plugin may contribute to any tree's menu (e.g. the Terminal's "Open in Terminal" on Files
    // folders) — `when` clauses match namespaced contextValues, so they only show where intended.
    const items: ContextMenuItem[] = registry.commands
      .filter((c) => c.when && evaluateWhen(c.when, ctx))
      .map((c) => ({
        id: c.id,
        label: stripCategory(c.title),
        danger: Boolean(c.confirm),
        run: () => void runContextCommand(c, connection, node, refresh),
      }));

    const builtIns: ContextMenuItem[] = [{ id: "core.refresh", label: "Refresh", run: refresh }];
    if (!node) {
      const dashboard = registry.views.find(
        (v) => v.tier === 2 && v.connectionType === connection.typeId && v.pluginId === connection.pluginId,
      );
      if (dashboard) builtIns.push({ id: "core.openDashboard", label: `Open ${dashboard.title}`, run: () => openDashboard(connection, dashboard) });
      builtIns.push({ id: "core.editConnection", label: `Edit ${nounFor(connection).one}…`, run: () => setEditConnection(connection) });
      builtIns.push({ id: "core.removeConnection", label: `Remove ${nounFor(connection).one}`, danger: true, run: () => void removeConnection(connection) });
    }
    if (node?.openView) {
      const { viewId, title, params, icon } = node.openView;
      builtIns.push({
        id: "core.openSecondary",
        label: "Open in Secondary Side Bar",
        run: () =>
          secondary.show({
            title: title ?? node.label,
            pluginId: connection.pluginId,
            viewId,
            connectionId: connection.id,
            ...(params ? { params: { ...params } } : {}),
            ...(icon ? { icon } : {}),
          }),
      });
    }
    if (items.length > 0) builtIns[0] = { ...builtIns[0]!, separator: true };

    setMenu({ x: e.clientX, y: e.clientY, items: [...items, ...builtIns] });
  }

  async function runContextCommand(
    command: ContributionRegistrySnapshot["commands"][number],
    connection: ConnectionSummary,
    node: TreeNode | undefined,
    refresh: () => void,
  ) {
    const label = node?.label ?? connection.name;
    const title = stripCategory(command.title);

    if (command.confirm) {
      const ok = await prompts.confirm({
        title,
        message: command.confirm.replaceAll("{label}", label),
        confirmLabel: title,
        danger: true,
      });
      if (!ok) return;
    }

    let input: Record<string, unknown> = {};
    if (command.inputSchema) {
      const initial: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(command.inputSchema.properties ?? {})) {
        if (prop.default !== undefined) {
          initial[key] = typeof prop.default === "string" ? prop.default.replaceAll("{label}", label) : prop.default;
        }
      }
      const answers = await prompts.input({ title, schema: command.inputSchema, initial });
      if (!answers) return;
      input = answers;
    }

    const data = node?.data && typeof node.data === "object" ? (node.data as Record<string, unknown>) : {};
    const arg = { connectionId: connection.id, ...data, ...(node ? { node } : {}), ...input };

    try {
      const result = await window.oneclient.executeCommand(command.id, [arg]);
      if (result === undefined || result === null) return;
      if (typeof result === "object" && "ok" in result) {
        const r = result as { ok: boolean; error?: string; openNode?: TreeNode; revealView?: string };
        if (!r.ok) {
          pushToast("error", `${title}: ${r.error ?? "failed"}`);
          return;
        }
        if (command.pluginId === connection.pluginId) refresh();
        if (r.openNode) openNodeView(connection, r.openNode);
        // e.g. { revealView: "terminal.panel" } — show that panel view.
        const panelKey = r.revealView ? panel.keyForViewId(r.revealView) : null;
        if (panelKey) panel.show(panelKey);
        return;
      }
      openTab({ id: `cmd:${command.id}:${Date.now()}`, title: `${title}: ${label}`, kind: "command-result", result });
    } catch (err) {
      pushToast("error", `${title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** "Server", "Folder"… — what this connection's plugin calls it. */
  const nounFor = (connection: ConnectionSummary) => connectionLabel(registry.connectionTypes.filter((t) => t.pluginId === connection.pluginId && t.id === connection.typeId));

  async function removeConnection(connection: ConnectionSummary) {
    const openTabs = tabs.filter((t) => t.kind === "tier2-view" && t.connectionId === connection.id);
    const unsaved = openTabs.filter((t) => dirtyViews.has(t.id)).length;
    const noun = nounFor(connection);
    const ok = await prompts.confirm({
      title: `Remove ${noun.one}`,
      message:
        `Remove "${connection.name}"? This only forgets the ${noun.one.toLowerCase()} in oneClient — nothing on the target is deleted.` +
        (unsaved > 0 ? `\n\n${unsaved} open tab(s) have unsaved changes that will be lost.` : ""),
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    closeTabs(openTabs.map((t) => t.id));
    try {
      await window.oneclient.deleteConnection(connection.id);
    } catch (err) {
      pushToast("error", `Remove ${nounFor(connection).one}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function runContributedCommand(commandId: string, title: string) {
    try {
      const result = await window.oneclient.executeCommand(commandId);
      openTab({ id: `cmd:${commandId}:${Date.now()}`, title, kind: "command-result", result });
    } catch (err) {
      openTab({
        id: `cmd:${commandId}:${Date.now()}`,
        title: `${title} (error)`,
        kind: "command-result",
        result: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  function openDashboard(connection: ConnectionSummary, view: { pluginId: string; id: string; title: string }) {
    const instanceId = `${view.pluginId}:${view.id}:${connection.id}`;
    openTab({
      id: instanceId,
      title: `${view.title}: ${connection.name}`,
      kind: "tier2-view",
      instanceId,
      pluginId: view.pluginId,
      viewId: view.id,
      connectionId: connection.id,
    });
  }

  /** Ctrl+Shift+F / Ctrl+Shift+H: the Search sidebar, focused (with the replace row for Replace in Files). */
  function openFindInFiles(replace = false) {
    container.show("search");
    // The view mounts on the first show; let it render before focusing.
    setTimeout(() => searchRef.current?.focus({ replace }), 0);
  }
  findInFilesRef.current = openFindInFiles;

  /** An open folder as the "connection" its tabs and commands belong to (owned by core). */
  function folderOwner(folderId: string): ConnectionSummary {
    const folder = foldersRef.current.find((x) => x.id === folderId);
    return { id: folderId, name: folder?.name ?? "", typeId: "folder", pluginId: CORE_PLUGIN_ID };
  }
  /** A connection — or a workspace folder — by id. */
  const ownerOf = (id: string): ConnectionSummary | undefined =>
    connections.find((c) => c.id === id) ?? (foldersRef.current.some((x) => x.id === id) ? folderOwner(id) : undefined);

  /** Open a file of a workspace folder in the editor — the same tab the Explorer would open. */
  function openWorkspaceFileTab(folderId: string, relPath: string) {
    const name = relPath.slice(relPath.lastIndexOf("/") + 1);
    openNodeView(folderOwner(folderId), {
      id: relPath,
      label: name,
      nodeType: FILE_NODE,
      collapsible: "none",
      resource: { name, kind: "file" },
      openView: { viewId: EDITOR_VIEW_ID, title: name, params: { path: relPath } },
    });
  }
  const openWorkspaceFileRef = useRef(openWorkspaceFileTab);
  openWorkspaceFileRef.current = openWorkspaceFileTab;

  /** Opens a global-search result: a view as a tab, or runs the plugin command it names (and opens what that returns). */
  async function openSearchHit(hit: SearchHit) {
    setSearchOpen(false);
    const connection = ownerOf(hit.connectionId);
    if (!connection) return pushToast("error", "That connection or folder no longer exists.");
    if (hit.openView) {
      openNodeView(connection, {
        id: hit.id ?? hit.label,
        label: hit.label,
        nodeType: "search.result",
        collapsible: "none",
        ...(hit.resource ? { resource: hit.resource } : {}),
        openView: hit.openView,
      });
      return;
    }
    if (!hit.command) return;
    try {
      const result = (await window.oneclient.executeCommand(hit.command.id, [{ connectionId: connection.id, ...(hit.command.args ?? {}) }])) as
        | { ok: boolean; error?: string; openNode?: TreeNode; revealView?: string }
        | undefined;
      if (result && result.ok === false) return pushToast("error", `${hit.label}: ${result.error ?? "failed"}`);
      if (result?.openNode) openNodeView(connection, result.openNode);
      const panelKey = result?.revealView ? panel.keyForViewId(result.revealView) : null;
      if (panelKey) panel.show(panelKey);
    } catch (err) {
      pushToast("error", `${hit.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function openNodeView(connection: ConnectionSummary, node: TreeNode) {
    if (!node.openView) return;
    const { viewId, title, params, icon } = node.openView;
    // Views that declare `dock: "secondary"` (the AI chat) open in the secondary side bar, not as an editor tab.
    if (registry.views.some((v) => v.pluginId === connection.pluginId && v.id === viewId && v.dock === "secondary")) {
      return secondary.show({ title: title ?? node.label, pluginId: connection.pluginId, viewId, connectionId: connection.id, ...(params ? { params: { ...params } } : {}), ...(icon ? { icon } : {}) });
    }
    const instanceId = `${connection.pluginId}:${viewId}:${connection.id}:${node.id}`;
    openTab({
      id: instanceId,
      title: title ?? node.label,
      kind: "tier2-view",
      instanceId,
      pluginId: connection.pluginId,
      viewId,
      connectionId: connection.id,
      params: params ? { ...params } : undefined,
      resource: node.resource,
      ...(icon ? { icon } : {}),
    });
  }

  /**
   * VS Code-style theme picker: arrowing through the list previews each theme
   * (applied, not saved); Enter keeps it, Esc reverts to the one you had.
   */
  async function openThemePicker(kind: "color" | "icon") {
    const items = kind === "color" ? await window.oneclient.listColorThemes() : await window.oneclient.listIconThemes();
    const set = kind === "color" ? window.oneclient.setColorTheme : window.oneclient.setIconTheme;
    const original = kind === "color" ? theme?.colorTheme.id : theme?.iconTheme.id;
    const kindLabel = { dark: "dark", light: "light", hc: "high contrast" } as const;
    setQuickPick({
      placeholder: kind === "color" ? "Select Color Theme (Up/Down Keys to Preview)" : "Select Icon Theme (Up/Down Keys to Preview)",
      initialId: original,
      commands: items.map((t) => ({
        id: t.id,
        title: t.label,
        description: [t.kind ? kindLabel[t.kind] : undefined, t.pluginId ?? "built-in"].filter(Boolean).join(" · "),
        run: () => void set(t.id, true),
      })),
      onActiveChange: (item) => void set(item.id, false),
      onClose: (accepted) => {
        if (!accepted && original) void set(original, false);
        setQuickPick(null);
      },
    });
  }

  function openManageMenu(e: React.MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.right + 4,
      y: r.bottom,
      items: [
        { id: "palette", label: "Command Palette…", run: () => setPaletteOpen(true) },
        { id: "color", label: "Color Theme…", separator: true, run: () => void openThemePicker("color") },
        { id: "icon", label: "Icon Theme…", run: () => void openThemePicker("icon") },
        { id: "welcome", label: "Welcome / Feature Guide", run: openWelcome },
        { id: "plugins", label: "Plugins", separator: true, run: () => openTab({ id: "plugin-manager", title: "Plugins", kind: "plugin-manager" }) },
      ],
    });
  }

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const builtins: PaletteCommand[] = [
      { id: "workbench.search", title: "Go to Anything… (Search Files, SQL Objects, …)", description: "Ctrl+P", run: () => setSearchOpen(true) },
      { id: "workbench.findInFiles", title: "Search: Find in Files", description: "Ctrl+Shift+F", run: () => openFindInFiles() },
      { id: "tasks.run", title: "Tasks: Run Task…", run: () => void pickTaskRef.current() },
      { id: "tasks.build", title: "Tasks: Run Build Task…", description: "Ctrl+Shift+B", run: () => void pickTaskRef.current("build") },
      { id: "tasks.show", title: "Tasks: Show Tasks", run: () => panel.show(TASKS_PANEL_KEY) },
      ...(["fetch", "pull", "push", "sync"] as const).map((m) => ({
        id: `git.${m}`,
        title: `Git: ${m[0]!.toUpperCase()}${m.slice(1)}`,
        run: () => void (activeRepoRef.current ? scmActionsRef.current.git(m, activeRepoRef.current.root).catch(() => undefined) : pushToast("error", "No git repository is open.")),
      })),
      { id: "git.checkout", title: "Git: Checkout to…", run: () => activeRepoRef.current && void scmActionsRef.current.pickBranch(activeRepoRef.current) },
      { id: "git.branch", title: "Git: Create Branch…", run: () => activeRepoRef.current && scmActionsRef.current.createBranch(activeRepoRef.current) },
      { id: "git.show", title: "View: Show Source Control", description: "Ctrl+Shift+G", run: () => container.show("scm") },
      { id: "workbench.closeAll", title: "View: Close All Editors", run: () => void closeAllTabs() },
      { id: "workbench.closeSaved", title: "View: Close Saved Editors", run: closeSavedTabs },
      { id: "workbench.splitRight", title: "View: Split Editor Right", run: () => activeTab && moveTab(activeTab.id, true) },
      { id: "workbench.moveLeft", title: "View: Move Editor to Left Group", run: () => activeTab && moveTab(activeTab.id, false) },
      { id: "workbench.welcome", title: "Help: Welcome / Feature Guide", run: openWelcome },
      { id: "workbench.reloadWindow", title: "Reload Window", run: () => location.reload() },
      { id: "workbench.openPluginManager", title: "Open Plugin Manager", run: () => openTab({ id: "plugin-manager", title: "Plugins", kind: "plugin-manager" }) },
      { id: "workbench.colorTheme", title: "Preferences: Color Theme…", run: () => void openThemePicker("color") },
      { id: "workbench.iconTheme", title: "Preferences: Icon Theme…", run: () => void openThemePicker("icon") },
      { id: "workbench.newConnection", title: "New Connection…", run: () => setNewConnectionFor({ pluginId: null }) },
      {
        id: "workbench.exportConnections",
        title: "Connections: Export…",
        run: () =>
          void window.oneclient
            .exportConnections(false)
            .then((r) => r && pushToast("info", `Exported ${r.count} connection${r.count === 1 ? "" : "s"} to ${r.path} (without passwords).`))
            .catch((err: unknown) => pushToast("error", `Export: ${err instanceof Error ? err.message : String(err)}`)),
      },
      {
        id: "workbench.exportConnectionsWithSecrets",
        title: "Connections: Export with Passwords (plain text)…",
        run: () => {
          if (!confirm("The file will contain your saved passwords and secrets in PLAIN TEXT. Keep it private. Continue?")) return;
          void window.oneclient
            .exportConnections(true)
            .then((r) => r && pushToast("info", `Exported ${r.count} connection${r.count === 1 ? "" : "s"} with passwords to ${r.path}.`))
            .catch((err: unknown) => pushToast("error", `Export: ${err instanceof Error ? err.message : String(err)}`));
        },
      },
      {
        id: "workbench.importConnections",
        title: "Connections: Import…",
        run: importConnections,
      },
      { id: "workbench.revealConfig", title: "Preferences: Show oneclient.json in File Manager", run: () => void window.oneclient.revealConfigFile() },
      { id: "workbench.toggleSecondary", title: "View: Toggle Secondary Side Bar", run: () => secondary.toggle() },
      { id: "workbench.openAiChat", title: "AI: Open Chat in Secondary Side Bar", run: openAiChat },
      { id: "workbench.openGitGraph", title: "Git: Open Git Graph", run: openGitGraph },
      ...(panelViews.length ? [{ id: "workbench.togglePanel", title: "View: Toggle Panel", run: () => panel.toggle() }] : []),
      ...panelViews.map((v) => ({
        id: `workbench.showPanel.${v.pluginId}.${v.id}`,
        title: `View: Show ${v.title}`,
        run: () => panel.show(`${v.pluginId}:${v.id}`),
      })),
    ];
    // Commands with a `when` guard need context (a tree node, a view) the palette can't supply.
    const contributed: PaletteCommand[] = registry.commands.filter((c) => !c.when && !c.hidden).map((c) => ({
      id: c.id,
      title: c.title,
      run: () => void runContributedCommand(c.id, c.title),
    }));
    return [...builtins, ...contributed];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry.commands, panelViews, panel.toggle, panel.show]);

  const activeView = activeTab?.kind === "tier2-view" ? activeTab : undefined;
  const terminalView = TERMINAL_VIEW;

  // ---- title bar menus ------------------------------------------------------------------------------------------

  /** Runs a command from a menu: shows its error, opens what it returns, reveals a panel view it names. */
  async function runMenuCommand(commandId: string, args: Record<string, unknown> = {}) {
    try {
      const result = (await window.oneclient.executeCommand(commandId, [args])) as { ok?: boolean; error?: string; openNode?: TreeNode; revealView?: string } | undefined;
      if (result?.ok === false) return pushToast("error", result.error ?? `${commandId} failed.`);
      const connection = typeof args.connectionId === "string" ? ownerOf(args.connectionId) : undefined;
      if (result?.openNode && connection) openNodeView(connection, result.openNode);
      const panelKey = result?.revealView ? panel.keyForViewId(result.revealView) : null;
      if (panelKey) panel.show(panelKey);
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : String(err));
    }
  }

  function captureEditTarget() {
    // A focused native view (an editor tab) takes focus away from the shell's document.
    editTarget.current = !document.hasFocus() && activeView ? { instanceId: activeView.instanceId } : { element: document.activeElement as HTMLElement | null };
  }
  function edit(role: EditRole) {
    const t = editTarget.current;
    if (t.instanceId) return void window.oneclient.editAction(role, t.instanceId);
    t.element?.focus?.();
    void window.oneclient.editAction(role);
  }
  /** Press a key in the active editor tab — menu items for what the editor does on a shortcut (Find, Save, Run…). */
  function pressInEditor(binding: string) {
    if (activeView) void window.oneclient.sendKeyToView(activeView.instanceId, parseKeybinding(binding));
  }

  async function newFile() {
    if (folders.length === 0) {
      pushToast("error", "Open a folder first (File ▸ Open Folder…).");
      return;
    }
    const multiple = folders.length > 1;
    const answers = await prompts.input({
      title: "New File",
      schema: {
        type: "object",
        required: multiple ? ["name", "folder"] : ["name"],
        properties: {
          name: { type: "string", title: multiple ? "File name (sub/folders/allowed.txt)" : `File name in “${folders[0]?.name ?? ""}”` },
          ...(multiple ? { folder: { type: "string", title: "Folder", enum: folders.map((x) => x.name) } } : {}),
        },
      },
      initial: multiple ? { folder: folders[0]?.name } : {},
    });
    if (!answers) return;
    const folder = folders.find((x) => x.name === answers.folder) ?? folders[0];
    if (folder) await runMenuCommand("files.newFile", { connectionId: folder.id, path: "", name: answers.name });
    if (folder) bumpExplorer(folder.id);
  }

  /** Explorer ▸ New Folder (toolbar): in the first open folder, or the one picked. */
  async function newFolderAtRoot() {
    const multiple = folders.length > 1;
    const answers = await prompts.input({
      title: "New Folder",
      schema: {
        type: "object",
        required: multiple ? ["name", "folder"] : ["name"],
        properties: { name: { type: "string", title: "Folder name" }, ...(multiple ? { folder: { type: "string", title: "In", enum: folders.map((x) => x.name) } } : {}) },
      },
      initial: multiple ? { folder: folders[0]?.name } : {},
    });
    if (!answers) return;
    const folder = folders.find((x) => x.name === answers.folder) ?? folders[0];
    if (!folder) return;
    await runMenuCommand("files.newFolder", { connectionId: folder.id, path: "", name: answers.name });
    bumpExplorer(folder.id);
  }

  async function openFolder() {
    const path = await window.oneclient.pickDirectory();
    if (!path) return;
    try {
      await window.oneclient.addWorkspaceFolder(path);
    } catch (err) {
      return pushToast("error", `Open Folder: ${err instanceof Error ? err.message : String(err)}`);
    }
    container.show("explorer");
  }

  /** File ▸ Close Folder / the folder's context menu: forget it (nothing on disk changes); its tabs close. */
  async function closeFolder(folder: WorkspaceFolderInfo) {
    const openTabs = tabs.filter((t) => t.kind === "tier2-view" && t.connectionId === folder.id);
    const unsaved = openTabs.filter((t) => dirtyViews.has(t.id)).length;
    if (unsaved > 0) {
      const ok = await prompts.confirm({
        title: "Close Folder",
        message: `${unsaved} open file(s) from "${folder.name}" have unsaved changes. Close the folder and discard them?`,
        confirmLabel: "Discard Changes",
        danger: true,
      });
      if (!ok) return;
    }
    closeTabs(openTabs.map((t) => t.id));
    await window.oneclient.removeWorkspaceFolder(folder.id);
  }

  const bumpExplorer = (folderId: string) => setExplorerTokens((prev) => ({ ...prev, [folderId]: (prev[folderId] ?? 0) + 1 }));

  /** Right-click in the Explorer: core's file actions, plus anything plugins contribute for files and folders. */
  function openFolderContextMenu(e: React.MouseEvent, folder: WorkspaceFolderInfo, node: TreeNode, refresh: () => void) {
    const owner = folderOwner(folder.id);
    const data = (node.data ?? {}) as { path?: string; fsPath?: string; root?: boolean };
    const path = data.path ?? "";
    const isDir = node.nodeType === FOLDER_NODE;
    const dir = isDir ? path : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const run = async (commandId: string, args: Record<string, unknown>, after?: (r: { openNode?: TreeNode }) => void) => {
      const r = (await window.oneclient.executeCommand(commandId, [{ connectionId: folder.id, ...args }]).catch((err: unknown) => ({ ok: false, error: String(err) }))) as {
        ok: boolean;
        error?: string;
        openNode?: TreeNode;
        revealView?: string;
      };
      if (!r.ok) return pushToast("error", r.error ?? "Failed.");
      after?.(r);
      const panelKey = r.revealView ? panel.keyForViewId(r.revealView) : null;
      if (panelKey) panel.show(panelKey);
    };
    const ask = (title: string, label: string, initial = "") =>
      prompts.input({ title, schema: { type: "object", required: ["name"], properties: { name: { type: "string", title: label } } }, initial: { name: initial } });

    const items: ContextMenuItem[] = [];
    if (isDir) {
      items.push(
        {
          id: "newFile",
          label: "New File…",
          run: () =>
            void ask("New File", "File name (a/b.txt creates folders too)").then(
              (a) => a && run("files.newFile", { path: dir, name: a.name }, (r) => (refresh(), r.openNode && openNodeView(owner, r.openNode))),
            ),
        },
        { id: "newFolder", label: "New Folder…", run: () => void ask("New Folder", "Folder name").then((a) => a && run("files.newFolder", { path: dir, name: a.name }, refresh)) },
      );
    }
    items.push(
      { id: "terminal", label: "Open in Integrated Terminal", separator: isDir, run: () => void run("terminal.openAt", { fsPath: data.fsPath }) },
      { id: "reveal", label: "Reveal in File Explorer", run: () => data.fsPath && void window.oneclient.revealPath(data.fsPath) },
      { id: "copyPath", label: "Copy Path", separator: true, run: () => data.fsPath && void navigator.clipboard.writeText(data.fsPath) },
      { id: "copyRel", label: "Copy Relative Path", run: () => void navigator.clipboard.writeText(path || ".") },
    );
    if (!data.root) {
      items.push(
        { id: "rename", label: "Rename…", separator: true, run: () => void ask(`Rename "${node.label}"`, "New name", node.label).then((a) => a && run("files.rename", { path, newName: a.name }, () => bumpExplorer(folder.id))) },
        {
          id: "delete",
          label: "Delete",
          danger: true,
          run: () =>
            void prompts
              .confirm({ title: "Delete", message: `Permanently delete "${node.label}"${isDir ? " and everything in it" : ""}? This can't be undone.`, confirmLabel: "Delete", danger: true })
              .then((ok) => {
                if (ok) void run("files.delete", { path }, () => bumpExplorer(folder.id));
              }),
        },
      );
    }
    // Plugins' file / folder commands (their `when` matches files.file / files.directory).
    const ctx: WhenContext = { contextValue: node.contextValue, nodeType: node.nodeType, connectionType: "folder" };
    const contributed = registry.commands.filter((c) => c.when && evaluateWhen(c.when, ctx));
    contributed.forEach((c, i) => items.push({ id: c.id, label: stripCategory(c.title), danger: Boolean(c.confirm), ...(i === 0 ? { separator: true } : {}), run: () => void runContextCommand(c, owner, node, refresh) }));
    items.push({ id: "refresh", label: "Refresh", separator: true, run: refresh });
    if (data.root) items.push({ id: "closeFolder", label: "Close Folder", run: () => void closeFolder(folder) });
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  async function showAbout() {
    const info = await window.oneclient.appInfo();
    const installed = plugins;
    await prompts.info({
      title: "About oneClient",
      body: (
        <div className="about">
          <div className="about-head">
            <Logo size={40} />
            <div>
              <div className="about-name">oneClient</div>
              <div className="about-tag">One client for everything.</div>
            </div>
          </div>
          <table className="about-table">
            <tbody>
              {[
                ["Version", info.version],
                ["Electron", info.electron],
                ["Chromium", info.chrome],
                ["Node.js", info.node],
                ["V8", info.v8],
                ["OS", info.platform],
                ["Plugins", `${installed.length} installed, ${installed.filter((p) => p.state === "active").length} active`],
                ["Settings", info.configDir],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ),
    });
  }

  // ---- source control ------------------------------------------------------------------------------------------

  const scmActions: ScmActions = {
    git: async (method, ...args) => {
      try {
        return await window.oneclient.git(method, ...args);
      } catch (err) {
        pushToast("error", `Git: ${(err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Git)?Error: /, "")}`);
        throw err;
      }
    },
    openDiff: (repo, path, left, right, title, origPath) => {
      const instanceId = `core:git.diff:${repo.root}:${path}:${left}:${right}`;
      const name = path.slice(path.lastIndexOf("/") + 1);
      openTab({
        id: instanceId,
        title,
        kind: "tier2-view",
        instanceId,
        pluginId: CORE_PLUGIN_ID,
        viewId: "git.diff",
        params: { root: repo.root, path, left, right, ...(origPath ? { origPath } : {}) },
        resource: { name, kind: "file" },
      });
    },
    openFile: (repo, path) => {
      const sep = repo.root.includes("\\") ? "\\" : "/";
      void window.oneclient
        .openWorkspaceFile(`${repo.root.replace(/[\\/]+$/, "")}${sep}${path.split("/").join(sep)}`)
        .catch(() => pushToast("error", `"${path}" isn't inside a folder open in the Explorer — open the repository's folder to edit it.`));
    },
    pickBranch: (repo) => void pickBranch(repo),
    menu: (e, items) => setMenu({ x: e.clientX, y: e.clientY, items }),
    confirm: (title, message, label) => prompts.confirm({ title, message, confirmLabel: label, danger: true }),
    createBranch: (repo) => void createBranch(repo),
    openFolder: () => void openFolder(),
    activeRoot: activeRepo?.root,
    setActive: (root) => {
      if (root === activeRepoRoot) return;
      localStorage.setItem("oneclient.scm.activeRepo", root);
      setActiveRepoRoot(root);
    },
  };

  async function createBranch(repo: RepoState, from?: string) {
    const a = await prompts.input({ title: from ? `Create Branch from ${from}` : "Create Branch", schema: { type: "object", required: ["name"], properties: { name: { type: "string", title: "Branch name" } } }, initial: {} });
    if (a) await scmActions.git("createBranch", repo.root, String(a.name).trim(), from).catch(() => undefined);
  }

  /** "Checkout to…": create a branch, or pick a local / remote branch or tag. */
  async function pickBranch(repo: RepoState) {
    let refs: Array<{ name: string; kind: string; current: boolean; sha: string }> = [];
    try {
      refs = (await window.oneclient.git("refs", repo.root)) as typeof refs;
    } catch (err) {
      return pushToast("error", `Git: ${err instanceof Error ? err.message : String(err)}`);
    }
    const checkout = (name: string) => void scmActions.git("checkout", repo.root, name).catch(() => undefined);
    setQuickPick({
      placeholder: `Select a branch or tag to checkout (${repo.name})`,
      commands: [
        { id: "new", title: "+ Create new branch…", run: () => void createBranch(repo) },
        { id: "newFrom", title: "+ Create new branch from…", run: () => void pickBranchSource(repo, refs) },
        ...refs.map((r) => ({
          id: `${r.kind}:${r.name}`,
          title: `${r.kind === "tag" ? "🏷 " : r.kind === "remote" ? "☁ " : "⎇ "}${r.name}`,
          description: `${r.current ? "current · " : ""}${r.kind === "local" ? "branch" : r.kind === "remote" ? "remote branch" : "tag"} · ${r.sha.slice(0, 8)}`,
          run: () => !r.current && checkout(r.name),
        })),
      ],
      onClose: () => setQuickPick(null),
    });
  }
  function pickBranchSource(repo: RepoState, refs: Array<{ name: string; kind: string; sha: string }>) {
    setQuickPick({
      placeholder: "Create the new branch from…",
      commands: refs.map((r) => ({ id: r.name, title: r.name, description: r.kind, run: () => void createBranch(repo, r.name) })),
      onClose: () => setQuickPick(null),
    });
  }

  // ---- tasks ----------------------------------------------------------------------------------------------------

  /** Show the Tasks panel on one task. */
  function showTask(id: string) {
    panel.show(TASKS_PANEL_KEY, { focus: false });
    setTimeout(() => window.dispatchEvent(new CustomEvent(TASKS_SELECT_EVENT, { detail: id })), 50);
  }

  /**
   * The web app's own right-click menu (the browser's is suppressed — see web/app-context-menu.ts). What it offers
   * depends on the panel the click was in (areas are marked with data-ctx in the shell); editing, link and
   * navigation items follow. Rebuilt every render so it always sees current state.
   */
  const contextMenuRef = useRef<(r: AppContextMenuRequest) => ContextMenuItem[]>(() => []);
  contextMenuRef.current = (r) => {
    const items: ContextMenuItem[] = [];
    const add = (item: ContextMenuItem) => void items.push({ ...item, separator: Boolean(item.separator) && items.length > 0 });
    const area = (name: string) => r.areas.find((a) => a.name === name);
    const copy = (text: string) => () => void navigator.clipboard?.writeText(text).catch(() => undefined);
    const edit = (role: "cut" | "copy" | "paste" | "selectAll") => () => {
      r.target?.focus();
      void window.oneclient.editAction(role, r.instanceId);
    };
    const go = (id: string, label: string, shortcut: WorkbenchShortcut, separator = false): ContextMenuItem => ({ id, label, separator, run: () => shortcutRef.current(shortcut) });

    // -- the panel that was clicked --
    const line = area("output-line");
    const log = area("output-log");
    const output = area("output");
    if (line) add({ id: "copyLine", label: "Copy Line", run: copy(line.text.trim()) });
    if (log) add({ id: "copyAll", label: "Copy All", run: copy(log.text.trim()) });
    if (output) {
      const channel = output.data.channel;
      if (channel) add({ id: "clearOutput", label: "Clear Output", separator: true, run: () => void window.oneclient.clearOutput(channel) });
    }

    const task = area("task");
    if (task) {
      const taskId = task.data.id ?? "";
      add({ id: "taskShow", label: "Show Output", run: () => showTask(taskId) });
      if (task.data.state === "running") add({ id: "taskStop", label: "Stop Task", run: () => void window.oneclient.cancelTask(taskId) });
      else if (task.data.definition) add({ id: "taskAgain", label: "Run Again", run: () => void window.oneclient.runTask(task.data.definition ?? "").catch((err: unknown) => pushToast("error", err instanceof Error ? err.message : String(err))) });
    }
    if (area("tasks")) {
      add({ id: "tasksRun", label: "Run Task…", separator: Boolean(task), run: () => void pickTask() });
      add({ id: "tasksClear", label: "Clear Finished Tasks", run: () => void window.oneclient.clearFinishedTasks() });
    }

    if (area("panel")) {
      for (const v of panelViews) {
        const key = `${v.pluginId}:${v.id}`;
        if (key !== panel.activeKey) add({ id: `panel:${key}`, label: `Show ${v.title}`, separator: items.length > 0 && !items.some((i) => i.id.startsWith("panel:")), run: () => panel.show(key) });
      }
      add({ id: "panelMax", label: "Maximize Panel", separator: true, run: () => panel.setHeight(window.innerHeight - 160) });
      add({ id: "panelClose", label: "Close Panel", run: () => panel.setOpen(false) });
    }

    const scm = area("scm");
    if (scm) {
      add({ id: "scmRefresh", label: "Refresh", run: () => void scmActions.git("refresh").catch(() => undefined) });
      if (activeRepo?.branch) add({ id: "scmSync", label: activeRepo.upstream ? "Synchronize Changes" : "Publish Branch", run: () => void scmActions.git(activeRepo.upstream ? "sync" : "push", activeRepo.root).catch(() => undefined) });
    }

    const sidebarArea = area("sidebar");
    if (sidebarArea && !scm) {
      const view = sidebarArea.data.view;
      if (view === "explorer" || !view) {
        add({ id: "openFolder", label: "Open Folder…", run: () => void openFolder() });
        add({ id: "newConnection", label: "New Connection…", run: () => setNewConnectionFor({ pluginId: null }) });
        add({
          id: "refreshExplorer",
          label: "Refresh Explorer",
          separator: true,
          run: () => setExplorerTokens((prev) => Object.fromEntries([...connections.map((c) => c.id), ...folders.map((f) => f.id), ...Object.keys(prev)].map((id) => [id, (prev[id] ?? 0) + 1]))),
        });
      } else if (view !== "search") {
        // A plugin's section: new connection of its type.
        add({ id: "newConnection", label: "New Connection…", run: () => setNewConnectionFor({ pluginId: view }) });
      } else {
        add({ id: "findInFiles", label: "Find in Files", run: () => shortcutRef.current("findInFiles") });
      }
    }

    if (area("activitybar")) {
      add(go("showExplorer", "Explorer", "showExplorer"));
      add(go("findInFiles", "Search", "findInFiles"));
      add(go("showScm", "Source Control", "showScm"));
      add(go("toggleSidebar", "Hide Side Bar", "toggleSidebar", true));
    }

    if (area("statusbar")) {
      add({ id: "toggleSecondary", label: "Toggle Secondary Side Bar", run: () => secondary.toggle() });
      add(go("toggleSidebar", "Toggle Side Bar", "toggleSidebar"));
      add(go("togglePanel", "Toggle Panel", "togglePanel"));
    }

    if (area("secondary")) {
      if (secondary.view) {
        const v = secondary.view;
        add({ id: "moveToEditor", label: "Move to Editor", run: () => undockView(v) });
      }
      add({ id: "closeSecondary", label: "Close Secondary Side Bar", run: () => secondary.hide() });
    }

    if ((area("editor") || area("tabbar")) && !area("panel")) {
      if (activeTab && tabs.length > 1) add({ id: "splitRight", label: "Split Editor Right", run: () => moveTab(activeTab.id, true) });
      if (tabs.length > 0) {
        add({ id: "closeSaved", label: "Close Saved Editors", run: () => closeSavedTabs() });
        add({ id: "closeAll", label: "Close All Editors", run: () => closeTabs(tabs.map((t) => t.id)) });
      }
      add({ id: "newConnection", label: "New Connection…", separator: true, run: () => setNewConnectionFor({ pluginId: null }) });
    }

    // -- editing, links --
    if (r.editable) {
      add({ id: "cut", label: "Cut", separator: true, run: edit("cut") });
      add({ id: "copy", label: "Copy", run: edit("copy") });
      add({ id: "paste", label: "Paste", run: edit("paste") });
      add({ id: "selectAll", label: "Select All", separator: true, run: edit("selectAll") });
    } else if (r.selection) {
      add({ id: "copySelection", label: "Copy", separator: true, run: edit("copy") });
      add({ id: "selectAll", label: "Select All", run: edit("selectAll") });
    }
    if (r.link) {
      const link = r.link;
      add({ id: "openLink", label: "Open Link in New Tab", separator: true, run: () => void window.open(link, "_blank", "noopener,noreferrer") });
      add({ id: "copyLink", label: "Copy Link Address", run: copy(link) });
    }

    // -- everywhere --
    add(go("commandPalette", "Command Palette…", "commandPalette", true));
    add(go("quickSearch", "Go to File or Connection…", "quickSearch"));
    add({ id: "reload", label: "Reload Window", separator: true, run: () => window.location.reload() });
    return items;
  };
  useEffect(() => {
    const onRequest = (e: Event) => {
      const r = (e as CustomEvent<AppContextMenuRequest>).detail;
      setMenu({ x: r.x, y: r.y, items: contextMenuRef.current(r) });
    };
    window.addEventListener(APP_CONTEXT_MENU_EVENT, onRequest);
    return () => window.removeEventListener(APP_CONTEXT_MENU_EVENT, onRequest);
  }, []);

  /** A button on a notification: run its command, or jump to a task / an Output channel. */
  function runNotificationAction(action: NotificationAction) {
    if (action.showTask) return showTask(action.showTask);
    if (action.showOutput) {
      localStorage.setItem(OUTPUT_SELECT_KEY, action.showOutput);
      window.dispatchEvent(new CustomEvent(OUTPUT_SELECT_EVENT, { detail: action.showOutput }));
      panelRef.current.show(OUTPUT_PANEL_KEY, { focus: false });
      return;
    }
    if (action.commandId) {
      void window.oneclient.executeCommand(action.commandId, action.args ?? []).catch((err: unknown) => {
        const id = Date.now();
        setToasts((prev) => [...prev, { id, kind: "error", message: err instanceof Error ? err.message : String(err) }]);
      });
    }
  }

  /** Terminal ▸ Run Task… (optionally only build / test tasks; a single default runs at once). */
  async function pickTask(group?: "build" | "test") {
    const defs = await window.oneclient.taskDefinitions().catch(() => []);
    const list = group ? defs.filter((d) => d.group === group) : defs;
    const run = (id: string) =>
      void window.oneclient
        .runTask(id)
        .then(showTask)
        .catch((err: unknown) => pushToast("error", `Run Task: ${err instanceof Error ? err.message : String(err)}`));
    const preferred = list.filter((d) => d.isDefault);
    if (group && (preferred.length === 1 || list.length === 1)) return run((preferred[0] ?? list[0])!.id);
    if (list.length === 0) {
      pushToast("error", group ? `No ${group} task found. Add one to .vscode/tasks.json or .oneclient/tasks.json (Terminal ▸ Configure Tasks…).` : "No tasks found in the open folders (package.json scripts, tasks.json, .NET solutions).");
      return;
    }
    const running = new Set(tasks.filter((t) => t.state === "running" && t.definitionId).map((t) => t.definitionId));
    setQuickPick({
      placeholder: group ? `Select the ${group} task to run` : "Select the task to run",
      commands: list.map((d) => ({
        id: d.id,
        title: `${running.has(d.id) ? "⟳ " : ""}${d.label}`,
        description: [d.folderName, d.detail ?? d.command, running.has(d.id) ? "running — restart" : ""].filter(Boolean).join(" · "),
        run: () => run(d.id),
      })),
      onClose: () => setQuickPick(null),
    });
  }

  function pickRunningTask() {
    const running = tasks.filter((t) => t.state === "running" && t.cancellable);
    setQuickPick({
      placeholder: "Select the task to terminate",
      commands: running.map((t) => ({ id: t.id, title: t.title, description: `${t.source}${t.detail ? ` · ${t.detail}` : ""}`, run: () => void window.oneclient.cancelTask(t.id) })),
      onClose: () => setQuickPick(null),
    });
  }

  /** Terminal ▸ Configure Tasks…: open (or create) .vscode/tasks.json in the first folder. */
  async function configureTasks() {
    const folder = folders[0];
    if (!folder) return pushToast("error", "Open a folder first (File ▸ Open Folder…).");
    const sep = folder.path.includes("\\") ? "\\" : "/";
    const file = `${folder.path}${sep}.vscode${sep}tasks.json`;
    const opened = await window.oneclient.openWorkspaceFile(file).then(
      () => true,
      () => false,
    );
    if (opened) return;
    // Doesn't exist yet: create it with an example, then open it.
    await window.oneclient.executeCommand("files.newFile", [{ connectionId: folder.id, path: "", name: ".vscode/tasks.json" }]);
    const template = `{\n  // Tasks for Terminal ▸ Run Task… (VS Code's format; \${workspaceFolder} etc. work).\n  "version": "2.0.0",\n  "tasks": [\n    {\n      "label": "build",\n      "type": "shell",\n      "command": "echo build",\n      "group": { "kind": "build", "isDefault": true }\n    }\n  ]\n}\n`;
    await window.oneclient.executeCommand("files.writeFile", [{ connectionId: folder.id, path: ".vscode/tasks.json", content: template }]);
    bumpExplorer(folder.id);
    await window.oneclient.openWorkspaceFile(file).catch(() => undefined);
  }

  const menus: TopMenu[] = buildMenus();
  pickTaskRef.current = pickTask;
  scmActionsRef.current = scmActions;
  reposRef.current = repos;
  activeRepoRef.current = activeRepo;
  function buildMenus(): TopMenu[] {
    const hasEditor = activeView !== undefined;
    const when: WhenContext = { activeView: activeView?.viewId, activePlugin: activeView?.pluginId };
    // Plugin items (contributes.menus): a command, or a keybinding pressed in the plugin's own active view.
    const contributed = (menuId: MenuId): MenuItem[] => {
      const items = registry.menus.filter((m) => m.menu === menuId && (!m.when || evaluateWhen(m.when, when)));
      const sorted = [...items].sort((a, b) => (a.group ?? "").localeCompare(b.group ?? ""));
      return sorted.flatMap((m, i): MenuItem[] => {
        const command = m.command ? registry.commands.find((c) => c.id === m.command && c.pluginId === m.pluginId) : undefined;
        const title = m.title ?? (command ? stripCategory(command.title) : (m.command ?? m.keybinding ?? ""));
        const separator = i > 0 && (sorted[i - 1]!.group ?? "") !== (m.group ?? "");
        const base = { id: `contrib:${m.pluginId}:${i}:${title}`, label: title, ...(m.keybinding ? { accel: m.keybinding } : {}), ...(separator ? { separator } : {}) };
        if (m.command) return command ? [{ ...base, run: () => void runMenuCommand(m.command!) }] : [];
        // A keybinding only reaches the plugin's own view.
        const own = activeView?.pluginId === m.pluginId;
        return m.keybinding ? [{ ...base, enabled: own, run: () => pressInEditor(m.keybinding!) }] : [];
      });
    };
    const withGroup = (items: MenuItem[]): MenuItem[] => (items.length ? [{ ...items[0]!, separator: true }, ...items.slice(1)] : []);
    const explorerId: ViewContainerId = "explorer";
    const sidebarShows = (id: ViewContainerId) => container.visible && container.active === id;
    const panelShows = (key: string) => panel.open && panel.activeKey === key;
    const runItems = contributed("run");

    return [
      {
        id: "file",
        label: "&File",
        items: [
          { id: "newFile", label: "New File…", accel: "Ctrl+N", run: () => void newFile() },
          { id: "newConnection", label: "New Connection…", accel: "Ctrl+Shift+N", run: () => setNewConnectionFor({ pluginId: null }) },
          { id: "openFolder", label: "Open Folder…", accel: "Ctrl+O", separator: true, run: () => void openFolder() },
          {
            id: "closeFolder",
            label: "Close Folder",
            submenu: folders.map((x) => ({ id: `close:${x.id}`, label: x.name, run: () => void closeFolder(x) })),
          },
          { id: "save", label: "Save", accel: "Ctrl+S", separator: true, enabled: hasEditor, run: () => pressInEditor("Ctrl+S") },
          { id: "closeEditor", label: "Close Editor", accel: "Ctrl+W", separator: true, enabled: tabs.length > 0, run: () => shortcutRef.current("closeEditor") },
          { id: "closeSaved", label: "Close Saved Editors", enabled: tabs.some((t) => !dirtyViews.has(t.id)), run: closeSavedTabs },
          { id: "closeAll", label: "Close All Editors", enabled: tabs.length > 0, run: () => void closeAllTabs() },
          activeTab && !split
            ? { id: "splitRight", label: "Split Editor Right", separator: true, enabled: tabs.length > 1, run: () => moveTab(activeTab.id, true) }
            : { id: "splitRight", label: focusRight ? "Move Editor to Left Group" : "Split Editor Right", separator: true, enabled: !!activeTab && (focusRight || tabs.length > 1), run: () => activeTab && moveTab(activeTab.id, !focusRight) },
          ...withGroup(contributed("file")),
          { id: "import", label: "Import Connections…", separator: true, run: importConnections },
          { id: "export", label: "Export Connections…", run: exportConnections },
          {
            id: "preferences",
            label: "Preferences",
            separator: true,
            submenu: [
              { id: "colorTheme", label: "Color Theme…", run: () => void openThemePicker("color") },
              { id: "iconTheme", label: "File Icon Theme…", run: () => void openThemePicker("icon") },
              { id: "settingsFile", label: "Show Settings File (oneclient.json)", separator: true, run: () => void window.oneclient.revealConfigFile() },
              { id: "configFolder", label: "Open Settings Folder", run: () => void window.oneclient.windowAction("revealConfigFolder") },
            ],
          },
          { id: "exit", label: "Exit", separator: true, run: () => void window.oneclient.windowAction("quit") },
        ],
      },
      {
        id: "edit",
        label: "&Edit",
        items: [
          { id: "undo", label: "Undo", accel: "Ctrl+Z", run: () => edit("undo") },
          { id: "redo", label: "Redo", accel: "Ctrl+Y", run: () => edit("redo") },
          { id: "cut", label: "Cut", accel: "Ctrl+X", separator: true, run: () => edit("cut") },
          { id: "copy", label: "Copy", accel: "Ctrl+C", run: () => edit("copy") },
          { id: "paste", label: "Paste", accel: "Ctrl+V", run: () => edit("paste") },
          { id: "selectAll", label: "Select All", accel: "Ctrl+A", run: () => edit("selectAll") },
          { id: "find", label: "Find", accel: "Ctrl+F", separator: true, enabled: hasEditor, run: () => pressInEditor("Ctrl+F") },
          { id: "replace", label: "Replace", accel: "Ctrl+H", enabled: hasEditor, run: () => pressInEditor("Ctrl+H") },
          { id: "findInFiles", label: "Find in Files", accel: "Ctrl+Shift+F", separator: true, run: () => openFindInFiles() },
          { id: "replaceInFiles", label: "Replace in Files", accel: "Ctrl+Shift+H", run: () => openFindInFiles(true) },
          ...withGroup(contributed("edit")),
        ],
      },
      {
        id: "view",
        label: "&View",
        items: [
          { id: "palette", label: "Command Palette…", accel: "Ctrl+Shift+P", run: () => setPaletteOpen(true) },
          { id: "goAnything", label: "Go to Anything…", accel: "Ctrl+P", run: () => setSearchOpen(true) },
          { id: "explorer", label: "Explorer", accel: "Ctrl+Shift+E", separator: true, checked: sidebarShows(explorerId), run: () => container.show(explorerId) },
          { id: "search", label: "Search", accel: "Ctrl+Shift+F", checked: sidebarShows("search"), run: () => openFindInFiles() },
          { id: "scm", label: "Source Control", accel: "Ctrl+Shift+G", checked: sidebarShows("scm"), run: () => container.show("scm") },
          ...explorerPlugins.map((p, i) => ({
            id: `plugin:${p.id}`,
            label: p.displayName ?? p.id,
            ...(i === 0 ? { separator: true } : {}),
            checked: sidebarShows(`plugin:${p.id}`),
            run: () => container.show(`plugin:${p.id}`),
          })),
          { id: "plugins", label: "Plugins", accel: "Ctrl+Shift+X", separator: true, checked: sidebarShows("plugins"), run: () => container.show("plugins") },
          ...panelViews.map((v, i) => ({
            id: `panel:${v.pluginId}:${v.id}`,
            label: v.title,
            ...(i === 0 ? { separator: true } : {}),
            ...(v.id === "terminal.panel" ? { accel: "Ctrl+`" } : `${v.pluginId}:${v.id}` === OUTPUT_PANEL_KEY ? { accel: "Ctrl+Shift+U" } : {}),
            checked: panelShows(`${v.pluginId}:${v.id}`),
            run: () => panel.show(`${v.pluginId}:${v.id}`),
          })),
          {
            id: "appearance",
            label: "Appearance",
            separator: true,
            submenu: [
              { id: "sidebar", label: "Primary Side Bar", accel: "Ctrl+B", checked: container.visible, run: () => shortcutRef.current("toggleSidebar") },
              { id: "secondary", label: "Secondary Side Bar", accel: "Ctrl+Alt+B", checked: secondary.open, run: () => secondary.toggle() },
              { id: "panel", label: "Panel", accel: "Ctrl+`", checked: panel.open, run: () => panel.toggle() },
              { id: "fullScreen", label: "Full Screen", accel: "F11", checked: fullScreen, separator: true, run: () => void window.oneclient.windowAction("toggleFullScreen") },
              { id: "zoomIn", label: "Zoom In", accel: "Ctrl+=", separator: true, run: () => void window.oneclient.windowAction("zoomIn") },
              { id: "zoomOut", label: "Zoom Out", accel: "Ctrl+-", run: () => void window.oneclient.windowAction("zoomOut") },
              { id: "zoomReset", label: "Reset Zoom", accel: "Ctrl+0", run: () => void window.oneclient.windowAction("zoomReset") },
            ],
          },
          ...withGroup(contributed("view")),
        ],
      },
      {
        id: "go",
        label: "&Go",
        items: [
          { id: "goFile", label: "Go to File / Object…", accel: "Ctrl+P", run: () => setSearchOpen(true) },
          { id: "goLine", label: "Go to Line…", accel: "Ctrl+G", enabled: hasEditor, run: () => pressInEditor("Ctrl+G") },
          { id: "nextEditor", label: "Next Editor", accel: "Ctrl+PageDown", separator: true, enabled: tabs.length > 1, run: () => shortcutRef.current("nextEditor") },
          { id: "prevEditor", label: "Previous Editor", accel: "Ctrl+PageUp", enabled: tabs.length > 1, run: () => shortcutRef.current("previousEditor") },
          {
            id: "switchEditor",
            label: "Switch Editor",
            submenu: tabs.map((t) => ({ id: `tab:${t.id}`, label: t.title, checked: t.id === activeTab?.id, run: () => activateTab(t.id) })),
          },
          ...withGroup(contributed("go")),
        ],
      },
      {
        id: "run",
        label: "&Run",
        items: runItems.length ? runItems : [{ id: "nothing", label: hasEditor ? "Nothing to run in this editor" : "Open a query or request to run it", enabled: false }],
      },
      {
        id: "terminal",
        label: "&Terminal",
        items: terminalView
          ? [
              { id: "newTerminal", label: "New Terminal", accel: "Ctrl+Shift+`", run: () => menuActionsRef.current.newTerminal() },
              { id: "runTask", label: "Run Task…", separator: true, run: () => void pickTask() },
              { id: "runBuild", label: "Run Build Task…", accel: "Ctrl+Shift+B", run: () => void pickTask("build") },
              { id: "runTest", label: "Run Test Task…", run: () => void pickTask("test") },
              { id: "terminateTask", label: "Terminate Task…", enabled: tasks.some((t) => t.state === "running" && t.cancellable), run: pickRunningTask },
              { id: "showTasks", label: "Show Tasks", run: () => panel.show(TASKS_PANEL_KEY) },
              { id: "configureTasks", label: "Configure Tasks…", run: () => void configureTasks() },
              { id: "killTerminal", label: "Kill Terminal", separator: true, run: () => void runMenuCommand("terminal.kill") },
              { id: "clearTerminal", label: "Clear Terminal", run: () => void runMenuCommand("terminal.clear") },
              {
                id: "showTerminal",
                label: "Show Terminal",
                accel: "Ctrl+`",
                separator: true,
                checked: panelShows(`${terminalView.pluginId}:${terminalView.id}`),
                run: () => panel.show(`${terminalView.pluginId}:${terminalView.id}`),
              },
              ...withGroup(contributed("terminal")),
            ]
          : [{ id: "noTerminal", label: "The terminal isn't available", enabled: false }],
      },
      {
        id: "help",
        label: "&Help",
        items: [
          { id: "welcome", label: "Welcome / Feature Guide", run: openWelcome },
          { id: "shortcuts", label: "Keyboard Shortcuts", run: () => void showShortcuts() },
          { id: "logs", label: "Show Logs (Output)", accel: "Ctrl+Shift+U", separator: true, run: () => panel.show(OUTPUT_PANEL_KEY) },
          { id: "devtools", label: "Toggle Developer Tools", accel: "Ctrl+Shift+I", run: () => void window.oneclient.windowAction("toggleDevTools") },
          { id: "reload", label: "Reload Window", run: () => void window.oneclient.windowAction("reload") },
          ...withGroup(contributed("help")),
          { id: "about", label: "About oneClient", separator: true, run: () => void showAbout() },
        ],
      },
    ];
  }

  /** Help ▸ Keyboard Shortcuts: everything the menus show a shortcut for, plus the editor keys. */
  async function showShortcuts() {
    const rows: Array<[string, string, string]> = [];
    const walk = (menuLabel: string, items: MenuItem[]) => {
      for (const item of items) {
        if (item.submenu) walk(menuLabel, item.submenu);
        else if (item.accel && !rows.some((r) => r[2] === item.accel && r[1] === item.label)) rows.push([menuLabel, item.label, item.accel]);
      }
    };
    for (const m of menus) walk(m.label.replace("&", ""), m.items);
    rows.push(
      ["Editor", "Format Document", "Shift+Alt+F"],
      ["Editor", "Find / Replace / Go to Line", "Ctrl+F / Ctrl+H / Ctrl+G"],
      ["Query editor", "Execute (selection or all)", "F5 / Ctrl+Enter"],
      ["Query editor", "Cancel query", "Esc"],
      ["Menus", "Open a menu", "Alt+letter"],
    );
    await prompts.info({
      title: "Keyboard Shortcuts",
      wide: true,
      body: (
        <table className="shortcuts-table">
          <tbody>
            {rows.map(([group, label, accel], i) => (
              <tr key={i}>
                <td className="shortcuts-group">{i === 0 || rows[i - 1]![0] !== group ? group : ""}</td>
                <td>{label}</td>
                <td>
                  <kbd>{accel}</kbd>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
    });
  }

  function exportConnections() {
    void window.oneclient
      .exportConnections(false)
      .then((r) => r && pushToast("info", `Exported ${r.count} connection${r.count === 1 ? "" : "s"} to ${r.path} (without passwords).`))
      .catch((err: unknown) => pushToast("error", `Export: ${err instanceof Error ? err.message : String(err)}`));
  }

  async function closeAllTabs() {
    const dirty = tabs.filter((t) => dirtyViews.has(t.id));
    if (dirty.length) {
      const ok = await prompts.confirm({
        title: "Unsaved Changes",
        message: `${dirty.length} editor(s) have unsaved changes. Close all and discard them?`,
        confirmLabel: "Discard Changes",
        danger: true,
      });
      if (!ok) return;
    }
    closeTabs(tabs.map((t) => t.id));
  }

  menuActionsRef.current = {
    newTerminal: () => void runMenuCommand("terminal.new"),
    showPlugins: () => container.show("plugins"),
    showOutput: () => panel.show(OUTPUT_PANEL_KEY),
    newConnection: () => setNewConnectionFor({ pluginId: null }),
    newFile: () => void newFile(),
    openFolder: () => void openFolder(),
  };

  shortcutRef.current = (shortcut: WorkbenchShortcut) => {
    const index = tabs.findIndex((t) => t.id === activeTab?.id);
    switch (shortcut) {
      case "togglePanel":
        return panel.toggle();
      case "commandPalette":
        return setPaletteOpen((v) => !v);
      case "quickSearch":
        return setSearchOpen((v) => !v);
      case "findInFiles":
        return openFindInFiles();
      case "showExplorer":
        return container.show("explorer");
      case "showScm":
        return container.show("scm");
      case "runBuildTask":
        return void pickTask("build");
      case "toggleSecondarySideBar":
        return secondary.toggle();
      case "toggleSidebar":
        return container.setVisible((v) => !v);
      case "closeEditor":
        if (activeTab) void requestCloseTab(activeTab.id);
        return;
      case "nextEditor":
        if (tabs.length > 1) activateTab(tabs[(index + 1) % tabs.length]!.id);
        return;
      case "previousEditor":
        if (tabs.length > 1) activateTab(tabs[(index - 1 + tabs.length) % tabs.length]!.id);
        return;
      case "zoomIn":
      case "zoomOut":
      case "zoomReset":
      case "toggleFullScreen":
        return void window.oneclient.windowAction(shortcut);
    }
  };

  // The native window buttons (drawn over the title bar on Windows / Linux) follow the theme.
  useEffect(() => {
    const bar = document.querySelector(".titlebar");
    if (!bar) return;
    const style = getComputedStyle(bar);
    void window.oneclient.setTitleBarColors(toHex(style.backgroundColor), toHex(style.color));
  }, [theme]);

  /** A drop target for a dragged tab: dropping moves it to that group. */
  const dropOn = (toRight: boolean) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain") || draggingTab;
      setDraggingTab(null);
      if (id) moveTab(id, toRight);
    },
  });

  /** Drag the divider between the two groups: the ratio is written straight to the area (one layout per frame), and React learns it at the end. */
  function startSplitResize(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const area = handle.parentElement as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("group-resizing");
    const rect = area.getBoundingClientRect();
    let latest = splitRatio;
    let frame = 0;
    const apply = () => {
      frame = 0;
      area.style.setProperty("--split", String(latest));
    };
    const onMove = (ev: PointerEvent) => {
      latest = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      if (frame) cancelAnimationFrame(frame);
      document.body.classList.remove("group-resizing");
      localStorage.setItem("oneclient.splitRatio", String(latest));
      setSplitRatio(latest);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  /** One group's tab strip with its compact action buttons (split / move, and a menu for closing). */
  function renderGroupBar(group: "left" | "right", groupTabs: Tab[], groupActiveId: string | undefined) {
    const target = groupTabs.find((t) => t.id === groupActiveId);
    return (
      <div
        key={group}
        className={`group-bar ${group} ${focusRight === (group === "right") && split ? "focused" : ""}`}
        onMouseDownCapture={() => setFocusRight(group === "right")}
        {...dropOn(group === "right")}
      >
        <div className="tab-bar" data-ctx="tabbar">
          {groupTabs.map((t) => {
            const dirty = dirtyViews.has(t.id);
            return (
              <div
                key={t.id}
                className={`tab ${t.id === groupActiveId ? "active" : ""}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", t.id);
                  e.dataTransfer.effectAllowed = "move";
                  setDraggingTab(t.id);
                }}
                onDragEnd={() => setDraggingTab(null)}
                onClick={() => activateTab(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openEditorMenu(e.clientX, e.clientY, group, t);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) void requestCloseTab(t.id);
                }}
              >
                {t.kind === "tier2-view" && t.resource && <TabIcon resource={t.resource} />}
                {t.kind === "tier2-view" && !t.resource && t.icon && <AssetIcon pluginId={t.pluginId} icon={t.icon} size={14} />}
                {t.title}
                <span
                  className={`tab-close ${dirty ? "dirty" : ""}`}
                  title={dirty ? "Unsaved changes — close" : "Close"}
                  onClick={(e) => {
                    e.stopPropagation();
                    void requestCloseTab(t.id);
                  }}
                />
              </div>
            );
          })}
        </div>
        <div className="tab-actions">
          {group === "left" ? (
            <button className="icon-button" title="Split Editor Right" aria-label="Split Editor Right" disabled={!target || tabs.length < 2} onClick={() => target && moveTab(target.id, true)}>
              <ThemeIcon id="split-right" size={15} />
            </button>
          ) : (
            <button className="icon-button" title="Move Editor to Left Group" aria-label="Move Editor to Left Group" disabled={!target} onClick={() => target && moveTab(target.id, false)}>
              <ThemeIcon id="split-right" size={15} />
            </button>
          )}
          <button
            className="icon-button"
            title="More Actions — Close All, Close Saved…"
            aria-label="More Actions"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openEditorMenu(r.right - 200, r.bottom + 2, group, undefined);
            }}
          >
            <ThemeIcon id="ellipsis" size={15} />
          </button>
        </div>
      </div>
    );
  }

  /** What a group shows for a tab that isn't a view (views are drawn by their slots above the pane). */
  function renderPane(group: "left" | "right", tab: Tab | undefined) {
    return (
      <div key={`pane-${group}`} className={`group-pane ${group} ${tab?.kind === "tier2-view" ? "bleed" : ""}`} onMouseDownCapture={() => setFocusRight(group === "right")}>
        {tab?.kind === "welcome" && (
          <WelcomePage
            plugins={plugins}
            onNewConnection={() => setNewConnectionFor({ pluginId: null })}
            onCommandPalette={() => setPaletteOpen(true)}
            onPlugins={() => openTab({ id: "plugin-manager", title: "Plugins", kind: "plugin-manager" })}
            onColorTheme={() => void openThemePicker("color")}
            onIconTheme={() => void openThemePicker("icon")}
            onImportConnections={importConnections}
          />
        )}
        {!tab && (
          <div className="welcome-empty">
            <p>No editors are open.</p>
            <button className="welcome-action" onClick={openWelcome}>Open the Feature Guide</button>
          </div>
        )}
        {tab?.kind === "plugin-manager" && <PluginManagerPanel plugins={plugins} hasConnections={(id) => registry.connectionTypes.some((t) => t.pluginId === id)} onTry={(id) => setNewConnectionFor({ pluginId: id })} />}
        {tab?.kind === "command-result" && <pre className="result">{JSON.stringify(tab.result, null, 2)}</pre>}
      </div>
    );
  }

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: container.visible
          ? `var(--activity-bar-width) ${sidebar.width}px 1fr`
          : "var(--activity-bar-width) 1fr",
      }}
    >
      <TitleBar menus={menus} onSearch={() => setSearchOpen(true)} onOpenChange={setMenuBarOpen} onBeforeOpen={captureEditTarget} actions={quickAccess} />

      <ActivityBar
        scmCount={scmCount}
        plugins={explorerPlugins}
        active={container.active}
        sidebarVisible={container.visible}
        onSelect={container.select}
        onManage={openManageMenu}
      />

      <div className="sidebar-wrapper" data-ctx="sidebar" data-ctx-view={container.active} style={{ width: sidebar.width }} hidden={!container.visible}>
        {/* Search stays mounted once opened, so its query and results survive switching containers. */}
        {(container.active === "search" || searchMounted) && (
          <div hidden={container.active !== "search"} className="sidebar-slot">
            <SearchView ref={searchRef} folders={folders} onOpenExplorer={() => void openFolder()} onError={(m) => pushToast("error", m)} />
          </div>
        )}
        {container.active === "explorer" && (
          <ExplorerView
            folders={folders}
            tokens={explorerTokens}
            onOpenFolder={() => void openFolder()}
            onNewFile={() => void newFile()}
            onNewFolder={() => void newFolderAtRoot()}
            onOpenNode={(folder, node) => openNodeView(folderOwner(folder.id), node)}
            onContextMenu={openFolderContextMenu}
          />
        )}
        {container.active === "scm" && <ScmView repos={repos} folders={folders} actions={scmActions} />}
        {container.active !== "search" && container.active !== "explorer" && container.active !== "scm" && (
        <Sidebar
          container={container.active}
          connections={connections}
          plugins={plugins}
          views={registry.views}
          connectionTypes={registry.connectionTypes}
          commands={registry.commands}
          onNewConnection={(pluginId) => setNewConnectionFor({ pluginId })}
          onRunCommand={(id, title) => void runContributedCommand(id, title)}
          onOpenPluginManager={() => openTab({ id: "plugin-manager", title: "Plugins", kind: "plugin-manager" })}
          onOpenDashboard={openDashboard}
          onOpenNodeView={openNodeView}
          explorerTokens={explorerTokens}
          explorerSections={registry.explorerSections}
          onExplorerContextMenu={openExplorerContextMenu}
        />
        )}
        <div className="sidebar-resize-handle" onPointerDown={sidebar.startResizing} />
      </div>

      <div className="center-row">
      <div className="main-area">
        <div className={`editor-area ${split ? "split" : ""}`} style={{ "--split": splitRatio } as React.CSSProperties}>
          <div className="editor-head">
            {renderGroupBar("left", leftTabs, leftActive?.id)}
            {split && renderGroupBar("right", rightTabs, rightActive?.id)}
          </div>

          <div className="tab-content" data-ctx="editor">
            {renderPane("left", leftActive)}
            {split && renderPane("right", rightActive)}
            {/* Every Tier 2 tab stays mounted (just hidden) so its view keeps its state across tab switches and across groups. */}
            {tabs.map((t) => {
              if (t.kind !== "tier2-view") return null;
              const group = rightIds.includes(t.id) ? "right" : "left";
              const groupActive = group === "right" ? rightActive : leftActive;
              return (
                <div key={t.instanceId} className={`tier2-slot g-${group}`} data-group={group} hidden={t.id !== groupActive?.id}>
                  <Tier2ViewHost
                    instanceId={t.instanceId}
                    pluginId={t.pluginId}
                    viewId={t.viewId}
                    connectionId={t.connectionId}
                    params={t.params}
                    active={t.id === groupActive?.id && !overlayOpen}
                  />
                </div>
              );
            })}
            {/* While a tab is being dragged: drop on a side to put it in that group (a view's iframe would swallow the drop). */}
            {draggingTab && (
              <>
                {split && <div className="drop-zone left" {...dropOn(false)}>Left group</div>}
                <div className={`drop-zone right ${split ? "" : "alone"}`} {...dropOn(true)}>{split ? "Right group" : "Split editor right"}</div>
              </>
            )}
          </div>
          {split && <div className="group-divider" onPointerDown={startSplitResize} title="Drag to resize the groups" />}
        </div>

        <Panel state={panel} overlayOpen={overlayOpen} onRunTask={() => void pickTask()} />
      </div>
      <SecondarySidebar state={secondary} overlayOpen={overlayOpen} onMoveToEditor={undockView} />
      </div>

      <div className="status-bar" data-ctx="statusbar">
        <span className="status-brand">
          <Logo size={14} /> oneClient
        </span>
        {activeRepo && (
          <>
            <button className="status-button" title={`${activeRepo.name} — Checkout to…`} onClick={() => pickBranch(activeRepo!)}>
              ⎇ {activeRepo.branch ?? activeRepo.headSha?.slice(0, 8) ?? "(no commits)"}
              {activeRepo.staged.length + activeRepo.unstaged.length + activeRepo.untracked.length + activeRepo.conflicts.length > 0 ? "*" : ""}
            </button>
            {activeRepo.branch && (
              <button
                className="status-button"
                title={activeRepo.upstream ? `Synchronize with ${activeRepo.upstream} (pull, then push)` : "Publish Branch"}
                onClick={() => void scmActions.git(activeRepo!.upstream ? "sync" : "push", activeRepo!.root).catch(() => undefined)}
              >
                {activeRepo.upstream ? `⟳ ${activeRepo.behind}↓ ${activeRepo.ahead}↑` : "☁ Publish"}
              </button>
            )}
          </>
        )}
        {(() => {
          const running = tasks.filter((t) => t.state === "running");
          if (running.length === 0) return null;
          const t = running[0]!;
          return (
            <button className="status-button status-task" title={running.map((x) => `${x.title}${x.detail ? ` — ${x.detail}` : ""}`).join("\n")} onClick={() => showTask(t.id)}>
              <span className="task-state spin">{STATE_ICON.running}</span> {t.title}
              {t.progress !== undefined ? ` ${Math.round(t.progress * 100)}%` : ""}
              {running.length > 1 ? ` (+${running.length - 1})` : ""}
            </button>
          );
        })()}
        <span>{plugins.filter((p) => p.state === "active").length} plugin(s) active</span>
        <span style={{ marginLeft: "auto" }}>Ctrl/Cmd+Shift+P — Command Palette</span>
        <NotificationBell onAction={runNotificationAction} />
        <button className={`status-button ${secondary.open ? "active" : ""}`} title="Toggle Secondary Side Bar (Ctrl+Alt+B)" onClick={() => secondary.toggle()}>
          <ThemeIcon id="secondary-sidebar" size={14} />
        </button>
        {/* One toggle for the whole panel; switching between its views is the panel's icon navigator. */}
        {panelViews.length > 0 && (
          <button
            className={`status-button ${panel.open ? "active" : ""}`}
            title={`${panel.open ? "Hide" : "Show"} Panel (Ctrl+\`)`}
            onClick={() => panel.toggle()}
          >
            ▤ Panel
          </button>
        )}
      </div>

      {searchOpen && <QuickSearch connectionCount={connections.length} onOpen={(hit) => void openSearchHit(hit)} onClose={() => setSearchOpen(false)} />}
      {paletteOpen && <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />}
      {quickPick && <CommandPalette {...quickPick} />}
      {newConnectionFor && (
        <NewConnectionDialog
          connectionTypes={registry.connectionTypes.filter(
            (t) => newConnectionFor.pluginId === null || t.pluginId === newConnectionFor.pluginId,
          )}
          onClose={() => setNewConnectionFor(null)}
          onCreated={() => void window.oneclient.listConnections().then(setConnections)}
        />
      )}
      {editConnection && (
        <NewConnectionDialog
          editId={editConnection.id}
          connectionTypes={registry.connectionTypes.filter((t) => t.pluginId === editConnection.pluginId && t.id === editConnection.typeId)}
          onClose={() => setEditConnection(null)}
          onCreated={() => {
            // Reconnect with the new settings: re-fetch the connection's tree.
            setExplorerTokens((prev) => ({ ...prev, [editConnection.id]: (prev[editConnection.id] ?? 0) + 1 }));
            void window.oneclient.listConnections().then(setConnections);
          }}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompts.element}
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast toast-${t.kind}`}
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            >
              {t.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Toast {
  id: number;
  kind: "error" | "info";
  message: string;
}

/** File-type icon on an editor tab (from the icon theme's file associations), if the theme has one. */
function TabIcon({ resource }: { resource: { name: string; kind: "file" | "folder" } }) {
  const icon = useResourceIcon(resource);
  return icon ? <AssetIcon pluginId="" icon={icon} size={14} /> : null;
}


/** "Ctrl+Shift+Enter" → the key press to send to a view. */
function parseKeybinding(binding: string): ViewKey {
  const parts = binding.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return { key: key.length === 1 ? key.toUpperCase() : key, ctrl: mods.has("ctrl"), shift: mods.has("shift"), alt: mods.has("alt") };
}

/** "rgb(37, 37, 38)" → "#252526" (the native title bar overlay wants hex). */
function toHex(color: string): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!m) return color;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}
