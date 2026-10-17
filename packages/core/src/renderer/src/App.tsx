import { useEffect, useMemo, useRef, useState } from "react";
import type { TreeNode } from "@oneclient/plugin-api";
import type { SearchHit } from "../../shared/ipc-contract.js";
import type { ConnectionSummary, ContributionRegistrySnapshot, PluginSummary } from "../../shared/types.js";
import { ActivityBar, type ViewContainerId } from "./components/ActivityBar.js";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette.js";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu.js";
import { Logo } from "./components/Logo.js";
import { AssetIcon } from "./components/AssetIcon.js";
import { ThemeIcon, useResourceIcon, useThemeState } from "./theme.js";
import { QuickSearch } from "./components/QuickSearch.js";
import { WelcomePage } from "./components/WelcomePage.js";
import { OUTPUT_PANEL_KEY, OUTPUT_VIEW, Panel, usePanel } from "./components/Panel.js";
import { OUTPUT_SELECT_EVENT, OUTPUT_SELECT_KEY } from "./components/OutputView.js";
import { usePrompts } from "./components/PromptDialogs.js";
import { evaluateWhen, type WhenContext } from "./when.js";
import { NewConnectionDialog } from "./components/NewConnectionDialog.js";
import { connectionLabel } from "./connection-label.js";
import { PluginManagerPanel } from "./components/PluginManagerPanel.js";
import { Sidebar, stripCategory } from "./components/Sidebar.js";
import { Tier2ViewHost } from "./components/Tier2ViewHost.js";

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
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (!resizing) return;
    function onMove(e: MouseEvent) {
      setWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX - ACTIVITY_BAR_WIDTH)));
    }
    function onUp() {
      setResizing(false);
    }
    document.body.classList.add("sidebar-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.classList.remove("sidebar-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width));
  }, [width]);

  return { width, resizing, startResizing: () => setResizing(true) };
}

const CONTAINER_STORAGE_KEY = "oneclient.activeViewContainer";

/** Built-in plugins pinned to the top of the activity bar, in this order; everything else keeps load order. */
const BUILT_IN_PLUGINS = ["oneclient-files", "oneclient-terminal"];
function builtInRank(pluginId: string): number {
  const i = BUILT_IN_PLUGINS.indexOf(pluginId);
  return i === -1 ? BUILT_IN_PLUGINS.length : i;
}

/** Activity-bar selection: which view container the sidebar shows, and whether the sidebar is open. */
function useViewContainer(explorerPlugins: PluginSummary[]) {
  const [active, setActive] = useState<ViewContainerId | null>(
    () => localStorage.getItem(CONTAINER_STORAGE_KEY) as ViewContainerId | null,
  );
  const [visible, setVisible] = useState(true);

  // Fall back to the first plugin explorer (Files, on a fresh install) when nothing is
  // remembered or the remembered one is gone (uninstalled/disabled).
  const resolved: ViewContainerId =
    active !== null && (active === "plugins" || explorerPlugins.some((p) => `plugin:${p.id}` === active))
      ? active
      : explorerPlugins[0]
        ? `plugin:${explorerPlugins[0].id}`
        : "plugins";

  function select(id: ViewContainerId) {
    if (id === resolved) {
      setVisible((v) => !v);
      return;
    }
    setActive(id);
    setVisible(true);
    localStorage.setItem(CONTAINER_STORAGE_KEY, id);
  }

  return { active: resolved, visible, select };
}

export function App() {
  const [registry, setRegistry] = useState<ContributionRegistrySnapshot>(emptyRegistry);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  // The Welcome tab can be closed; closing it keeps it closed on the next start (reopen it from the palette or the gear menu).
  const welcomeClosed = localStorage.getItem("oneclient.welcomeClosed") === "1";
  const [tabs, setTabs] = useState<Tab[]>(welcomeClosed ? [] : [{ id: "welcome", title: "Welcome", kind: "welcome" }]);
  const [activeTabId, setActiveTabId] = useState(welcomeClosed ? "" : "welcome");
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
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** Tier 2 view instances (= tab ids) that reported unsaved changes. */
  const [dirtyViews, setDirtyViews] = useState<Set<string>>(new Set());
  const prompts = usePrompts();
  // Tier 2 views are native layers drawn *over* this DOM, so hide them while
  // anything floating (menu, dialog, palette) is open or it'd be covered.
  const overlayOpen = paletteOpen || searchOpen || quickPick !== null || newConnectionFor !== null || menu !== null || prompts.element !== null;

  // Plugins that get an activity-bar explorer: anything not disabled/broken that contributes connection types.
  const explorerPlugins = useMemo(
    () =>
      plugins
        .filter(
          (p) =>
            p.state !== "disabled" &&
            p.state !== "invalid" &&
            p.state !== "incompatible" &&
            registry.connectionTypes.some((t) => t.pluginId === p.id),
        )
        .sort((a, b) => builtInRank(a.id) - builtInRank(b.id)),
    [plugins, registry.connectionTypes],
  );
  const container = useViewContainer(explorerPlugins);

  // Bottom panel: every Tier 2 view contributed with location "panel" (e.g. the Terminal).
  const panelViews = useMemo(
    () => [
      ...registry.views
        .filter((v) => v.tier === 2 && v.location === "panel")
        .sort((a, b) => builtInRank(a.pluginId) - builtInRank(b.pluginId)),
      OUTPUT_VIEW, // the shell's own Output log, always last
    ],
    [registry.views],
  );
  const panel = usePanel(panelViews);
  const findInFilesRef = useRef<() => void>(() => {});
  const panelToggleRef = useRef(panel.toggle);
  panelToggleRef.current = panel.toggle;
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
    const offShortcut = window.oneclient.onShortcut((shortcut) => {
      if (shortcut === "togglePanel") panelToggleRef.current();
      else if (shortcut === "commandPalette") setPaletteOpen((v) => !v);
      else if (shortcut === "quickSearch") setSearchOpen((v) => !v);
      else if (shortcut === "findInFiles") findInFilesRef.current();
    });
    // A view revealing another view of its plugin — today that means a panel view (e.g. Query Results).
    // A plugin view asking for another of its views in a new tab (e.g. a table row → that row's editor).
    const offExplorerRefresh = window.oneclient.onExplorerRefresh((connectionId) => setExplorerTokens((prev) => ({ ...prev, [connectionId]: (prev[connectionId] ?? 0) + 1 })));
    const offOpenView = window.oneclient.onOpenViewRequest((e) => {
      const known = registryRef.current.views.some((v) => v.pluginId === e.pluginId && v.id === e.viewId && v.tier === 2);
      if (!known) return;
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
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        findInFilesRef.current();
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (mod && !e.shiftKey && (e.key === "`" || e.code === "Backquote")) {
        e.preventDefault();
        panelToggleRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Switching to a plugin tab gives its view keyboard focus — so typing goes to it, and it learns
  // it's the active one (e.g. the query editor tells Query Results which window's results to show).
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.kind !== "tier2-view") return;
    const timer = setTimeout(() => void window.oneclient.focusView(tab.instanceId), 80);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

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

  function openTab(tab: Tab) {
    setTabs((prev) => (prev.some((t) => t.id === tab.id) ? prev : [...prev, tab]));
    setActiveTabId(tab.id);
  }

  function closeTabs(ids: string[]) {
    const closing = new Set(ids);
    const index = tabs.findIndex((t) => closing.has(t.id));
    const remaining = tabs.filter((t) => !closing.has(t.id));
    if (closing.has("welcome")) localStorage.setItem("oneclient.welcomeClosed", "1");
    setTabs(remaining);
    setDirtyViews((prev) => new Set([...prev].filter((id) => !closing.has(id))));
    // Like VS Code: closing the active tab focuses its neighbour, not the first tab.
    if (closing.has(activeTabId)) setActiveTabId(remaining[Math.min(index, remaining.length - 1)]?.id ?? "");
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
      builtIns.push({ id: "core.removeConnection", label: `Remove ${nounFor(connection).one}`, danger: true, run: () => void removeConnection(connection) });
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

  /** Ctrl+Shift+F: the Files plugin's Search view for an open folder (the one in the sidebar if there is one). */
  function openFindInFiles() {
    const view = registry.views.find((v) => v.id === "files.search" && v.tier === 2);
    const candidates = view ? connections.filter((c) => c.pluginId === view.pluginId) : [];
    const connection = candidates[0];
    if (!view || !connection) return pushToast("error", "Search needs an open folder — add a Folder connection in the Files plugin first.");
    openDashboard(connection, { pluginId: view.pluginId, id: view.id, title: "Search" });
  }
  findInFilesRef.current = openFindInFiles;

  /** Opens a global-search result: a view as a tab, or runs the plugin command it names (and opens what that returns). */
  async function openSearchHit(hit: SearchHit) {
    setSearchOpen(false);
    const connection = connections.find((c) => c.id === hit.connectionId);
    if (!connection) return pushToast("error", "That connection no longer exists.");
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
      { id: "workbench.findInFiles", title: "Search: Find in Files", description: "Ctrl+Shift+F", run: openFindInFiles },
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

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: container.visible
          ? `var(--activity-bar-width) ${sidebar.width}px 1fr`
          : "var(--activity-bar-width) 1fr",
      }}
    >
      <div className="topbar">
        <button className="topbar-search" onClick={() => setSearchOpen(true)} title="Search files, SQL objects and more (Ctrl+P)">
          <ThemeIcon id="search" size={14} />
          <span>Search files, tables, procedures…</span>
          <kbd>Ctrl+P</kbd>
        </button>
      </div>

      <ActivityBar
        plugins={explorerPlugins}
        active={container.active}
        sidebarVisible={container.visible}
        onSelect={container.select}
        onManage={openManageMenu}
      />

      <div className="sidebar-wrapper" style={{ width: sidebar.width }} hidden={!container.visible}>
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
        <div
          className={`sidebar-resize-handle ${sidebar.resizing ? "active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            sidebar.startResizing();
          }}
        />
      </div>

      <div className="main-area">
        <div className="tab-bar">
          {tabs.map((t) => {
            const dirty = dirtyViews.has(t.id);
            return (
              <div
                key={t.id}
                className={`tab ${t.id === activeTabId ? "active" : ""}`}
                onClick={() => setActiveTabId(t.id)}
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

        <div className={`tab-content ${activeTab?.kind === "tier2-view" ? "tab-content-bleed" : ""}`}>
          {activeTab?.kind === "welcome" && (
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
          {!activeTab && (
            <div className="welcome-empty">
              <p>No editors are open.</p>
              <button className="welcome-action" onClick={openWelcome}>Open the Feature Guide</button>
            </div>
          )}
          {activeTab?.kind === "plugin-manager" && <PluginManagerPanel plugins={plugins} />}
          {activeTab?.kind === "command-result" && (
            <pre className="result">{JSON.stringify(activeTab.result, null, 2)}</pre>
          )}
          {/* Every Tier 2 tab stays mounted (just hidden) so its view keeps its state across tab switches. */}
          {tabs.map(
            (t) =>
              t.kind === "tier2-view" && (
                <div key={t.instanceId} className="tier2-slot" hidden={t.id !== activeTab?.id}>
                  <Tier2ViewHost
                    instanceId={t.instanceId}
                    pluginId={t.pluginId}
                    viewId={t.viewId}
                    connectionId={t.connectionId}
                    params={t.params}
                    active={t.id === activeTab?.id && !overlayOpen}
                  />
                </div>
              ),
          )}
        </div>

        <Panel state={panel} overlayOpen={overlayOpen} />
      </div>

      <div className="status-bar">
        <span className="status-brand">
          <Logo size={14} /> oneClient
        </span>
        <span>{plugins.filter((p) => p.state === "active").length} plugin(s) active</span>
        <span style={{ marginLeft: "auto" }}>Ctrl/Cmd+Shift+P — Command Palette</span>
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

