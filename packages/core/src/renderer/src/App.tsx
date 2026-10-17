import { useEffect, useMemo, useState } from "react";
import type { ConnectionSummary, ContributionRegistrySnapshot, PluginSummary } from "../../shared/types.js";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette.js";
import { NewConnectionDialog } from "./components/NewConnectionDialog.js";
import { PluginManagerPanel } from "./components/PluginManagerPanel.js";
import { Sidebar } from "./components/Sidebar.js";

type Tab =
  | { id: "welcome"; title: "Welcome"; kind: "welcome" }
  | { id: "plugin-manager"; title: "Plugins"; kind: "plugin-manager" }
  | { id: string; title: string; kind: "command-result"; result: unknown };

const emptyRegistry: ContributionRegistrySnapshot = { connectionTypes: [], explorerNodes: [], views: [], commands: [] };

export function App() {
  const [registry, setRegistry] = useState<ContributionRegistrySnapshot>(emptyRegistry);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([{ id: "welcome", title: "Welcome", kind: "welcome" }]);
  const [activeTabId, setActiveTabId] = useState("welcome");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newConnectionOpen, setNewConnectionOpen] = useState(false);

  useEffect(() => {
    void window.oneclient.getRegistry().then(setRegistry);
    void window.oneclient.listPlugins().then(setPlugins);
    void window.oneclient.listConnections().then(setConnections);

    const offRegistry = window.oneclient.onRegistryChanged(setRegistry);
    const offPlugins = window.oneclient.onPluginsChanged(setPlugins);
    const offConnections = window.oneclient.onConnectionsChanged(setConnections);
    return () => {
      offRegistry();
      offPlugins();
      offConnections();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function openTab(tab: Tab) {
    setTabs((prev) => (prev.some((t) => t.id === tab.id) ? prev : [...prev, tab]));
    setActiveTabId(tab.id);
  }

  function closeTab(id: string) {
    setTabs((prev) => prev.filter((t) => t.id !== id));
    if (activeTabId === id) setActiveTabId("welcome");
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

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const builtins: PaletteCommand[] = [
      { id: "workbench.reloadWindow", title: "Reload Window", run: () => location.reload() },
      { id: "workbench.openPluginManager", title: "Open Plugin Manager", run: () => openTab({ id: "plugin-manager", title: "Plugins", kind: "plugin-manager" }) },
      { id: "workbench.newConnection", title: "New Connection…", run: () => setNewConnectionOpen(true) },
    ];
    const contributed: PaletteCommand[] = registry.commands.map((c) => ({
      id: c.id,
      title: c.title,
      run: () => void runContributedCommand(c.id, c.title),
    }));
    return [...builtins, ...contributed];
  }, [registry.commands]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  return (
    <div className="app">
      <Sidebar
        connections={connections}
        plugins={plugins}
        onNewConnection={() => setNewConnectionOpen(true)}
        onOpenPluginManager={() => openTab({ id: "plugin-manager", title: "Plugins", kind: "plugin-manager" })}
      />

      <div className="main-area">
        <div className="tab-bar">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${t.id === activeTabId ? "active" : ""}`}
              onClick={() => setActiveTabId(t.id)}
            >
              {t.title}
              {t.id !== "welcome" && (
                <span
                  style={{ marginLeft: 8, color: "var(--text-dim)" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  ×
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="tab-content">
          {activeTab?.kind === "welcome" && <WelcomeTab />}
          {activeTab?.kind === "plugin-manager" && <PluginManagerPanel plugins={plugins} />}
          {activeTab?.kind === "command-result" && (
            <pre className="result">{JSON.stringify(activeTab.result, null, 2)}</pre>
          )}
        </div>
      </div>

      <div className="status-bar">
        <span>oneClient — Phase 2</span>
        <span>{plugins.filter((p) => p.state === "active").length} plugin(s) active</span>
        <span style={{ marginLeft: "auto" }}>Ctrl/Cmd+Shift+P — Command Palette</span>
      </div>

      {paletteOpen && <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />}
      {newConnectionOpen && (
        <NewConnectionDialog
          connectionTypes={registry.connectionTypes}
          onClose={() => setNewConnectionOpen(false)}
          onCreated={() => void window.oneclient.listConnections().then(setConnections)}
        />
      )}
    </div>
  );
}

function WelcomeTab() {
  return (
    <div>
      <h1>oneClient</h1>
      <p>One client for everything. The core has no infrastructure-specific code — everything you see beyond this shell comes from installed plugins.</p>
      <p style={{ color: "var(--text-dim)" }}>
        Press <kbd>Ctrl/Cmd+Shift+P</kbd> for the command palette, or use the + button in the sidebar to add a
        connection.
      </p>
    </div>
  );
}
