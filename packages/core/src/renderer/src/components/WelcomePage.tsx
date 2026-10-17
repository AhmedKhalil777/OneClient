import { type ReactNode, useRef } from "react";
import type { PluginSummary } from "../../../shared/types.js";
import { Logo } from "./Logo.js";
import { AssetIcon } from "./AssetIcon.js";

interface Props {
  plugins: PluginSummary[];
  onNewConnection: () => void;
  onCommandPalette: () => void;
  onPlugins: () => void;
  onColorTheme: () => void;
  onIconTheme: () => void;
  onImportConnections: () => void;
}

interface Section {
  id: string;
  title: string;
  body: ReactNode;
}

/** What each built-in plugin offers. Anything not listed here still appears, with its manifest description. */
const PLUGIN_FEATURES: Record<string, string[]> = {
  "oneclient-files": [
    "Open a folder and browse it as a tree, with real file-type icons.",
    "Find in Files (Ctrl+Shift+F): text search with match case / whole word / regex, include and exclude globs, click-through to the match, and replace. Also contributes file names to the top search bar.",
    "Edit and save files; create, rename and delete files and folders from the context menu.",
    "A smart editor: format, breadcrumbs showing where the cursor is in the document, syntax highlighting, live preview and an Actions menu — all supplied by the Miscellaneous plugin below.",
    "Remembers line endings and the UTF-8 byte-order mark when saving.",
  ],
  "oneclient-misc": [
    "JSON: format and minify, breadcrumbs with the path at the cursor, syntax highlighting (.json, .jsonc, .geojson, .har, .webmanifest and well-known config files).",
    "XML: format, element-path breadcrumbs, syntax highlighting (.xml, .csproj, .config, .svg, .xaml, .resx, .nuspec and many more).",
    "SQL (.sql, .tsql, .ddl…): syntax highlighting, an outline of statements and CREATE objects in the breadcrumbs, a formatter (one clause per line, one column per line, upper-case keywords) and Uppercase / Lowercase Keywords actions.",
    "Markdown: live preview next to the source, heading outline in the breadcrumbs, syntax highlighting.",
    "Text utilities for every file: sort lines (ascending / descending), remove duplicate lines, trim trailing whitespace, ensure a final newline — on the selection when there is one.",
    "Material Icon Theme: the default file and folder icons in the explorer — 1,300+ file types, 2,000+ special file names and well-known folders (switch via Preferences: Icon Theme).",
  ],
  "oneclient-terminal": ["An integrated terminal in the bottom panel: PowerShell, Command Prompt, Git Bash, WSL, bash/zsh.", "Open a terminal at any folder from the Files explorer."],
  "oneclient-docker": ["Connect to a local or remote Docker Engine.", "Browse containers, images, volumes and networks; start, stop, restart and remove containers; pull images."],
  "oneclient-mssql": [
    "Connect to Microsoft SQL Server — an object explorer (databases, tables, views, procedures, functions…) and a query editor with result grids, like a small SSMS.",
    "IntelliSense: keywords, table and column names, and schema objects.",
    "Top search: type part of a table, view, procedure or function name to jump straight to it from any screen.",
    "Script tables as CREATE, select top 1000 rows, script procedures as EXECUTE; run and cancel queries; results and messages in the Query Results panel.",
  ],
  "oneclient-keycloak": [
    "Manage realms, users, groups, roles, clients, client scopes, identity providers, sessions and events.",
    "Edit any resource as JSON with formatting and breadcrumbs; create users with passwords, reset passwords, enable/disable, log out, unlock.",
    "Role mappings and group membership for users and groups; client secrets, installation config, realm export.",
    "Developer tools: get tokens (password, client-credentials, refresh), decode JWTs, introspect, UserInfo, evaluate what a client would receive.",
    "Every request is logged to the Output panel (secrets masked).",
  ],
  "oneclient-http": [
    "A Postman-style HTTP client: collections with folders, a request builder (params, headers, raw / urlencoded / form-data bodies, auth), and a response viewer with pretty JSON, headers, cookies and images.",
    "Environments and collection variables with {{name}} substitution, plus {{$guid}}, {{$timestamp}} and friends.",
    "Import Postman collections (v2.0 / v2.1), Postman environments and cURL commands; export collections and environments as Postman v2.1; “Copy as cURL”.",
    "History of the last 200 requests; every request is also logged to the Output panel.",
  ],
};

const STATE_LABEL: Record<string, string> = { active: "Active", inactive: "Ready", activating: "Starting", disabled: "Disabled", crashed: "Crashed", invalid: "Invalid", incompatible: "Incompatible" };

const Kbd = ({ children }: { children: ReactNode }) => <kbd className="doc-kbd">{children}</kbd>;

function Feature({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li>
      <strong>{title}</strong> — {children}
    </li>
  );
}

/**
 * The Welcome tab: quick actions, then a feature guide for the whole app — the shell, the config files, the
 * extension model, and what every installed plugin offers (read live from the plugin list, so it stays true).
 */
export function WelcomePage({ plugins, onNewConnection, onCommandPalette, onPlugins, onColorTheme, onIconTheme, onImportConnections }: Props) {
  const scroller = useRef<HTMLDivElement>(null);

  const sections: Section[] = [
    {
      id: "shell",
      title: "The workbench",
      body: (
        <ul>
          <Feature title="Activity bar">one icon per plugin; click to open that plugin’s sidebar (connections and its explorer tree). Click the active one again to hide the sidebar.</Feature>
          <Feature title="Sidebar">each plugin has a <em>Connections</em> section (use <strong>+</strong> to add one) and its explorer tree. Right-click any node for its commands; clicking a leaf opens it in an editor tab. Nothing is fetched until you expand it.</Feature>
          <Feature title="Editor tabs">requests, tables, editors and dashboards open as tabs (● marks unsaved changes and asks before closing). The ⊞ button on a connection opens its dashboard.</Feature>
          <Feature title="Bottom panel">Terminal, plugin result panels (for example SQL Query Results) and the <strong>Output</strong> log share one panel with an icon navigator. Toggle it with <Kbd>Ctrl+`</Kbd> or the Panel button in the status bar; drag its top edge to resize.</Feature>
          <Feature title="Search everything">the bar at the top (or <Kbd>Ctrl+P</Kbd>) searches <em>all</em> your connections at once. Every plugin that offers search answers in its own group: the Files plugin finds file names in your open folders (nested, fuzzy — "pm" finds plugin-manager.ts), the SQL Server plugin finds tables, views, procedures and functions across the databases and opens them directly. Results appear as each plugin answers; a slow or unreachable connection never blocks the rest.</Feature>
          <Feature title="Find in Files">press <Kbd>Ctrl+Shift+F</Kbd> (or the ⊞ button on a folder) for a VS Code-style text search in an open folder: match case, whole word, regular expressions, files to include / exclude, results grouped by file — click a result to open the file with the match selected — and replace (per file or all).</Feature>
          <Feature title="Command Palette">press <Kbd>Ctrl+Shift+P</Kbd> for every command: View: Toggle Panel, themes, connections, and anything plugins contribute.</Feature>
          <Feature title="Themes">pick a <strong>color theme</strong> and an <strong>icon theme</strong> from the gear menu or palette; plugins can ship their own color themes, icon themes and individual icons. Previews apply live.</Feature>
          <Feature title="Plugin Manager">enable or disable plugins (the choice is remembered); incompatible or invalid plugins are listed with the reason.</Feature>
        </ul>
      ),
    },
    {
      id: "connections",
      title: "Connections, config files & backup",
      body: (
        <>
          <ul>
            <Feature title="Connections">every plugin starts with none. A connection’s form is generated from the plugin’s schema; passwords and other secrets are stored encrypted with your OS keychain, never in plain files.</Feature>
            <Feature title="Where things are saved">
              everything lives in <code>~/.oneclient/</code>: <code>oneclient.json</code> (connections, disabled plugins, theme choices — no secrets, safe to share), <code>secrets.json</code> (encrypted secrets, this machine only) and plugin data such as <code>http/</code> workspaces. There is no database. Set <code>ONECLIENT_HOME</code> to move it.
            </Feature>
            <Feature title="Export / import connections">Command Palette → <em>Connections: Export…</em>, <em>Export with Passwords…</em> or <em>Import…</em>. Passwords are left out unless you ask; importing twice is harmless; you are warned about missing or older plugins.</Feature>
            <Feature title="Versioned & upgrade-safe">the files carry a format version and are migrated automatically on upgrade (with a <code>.bak</code> backup). A file from a newer oneClient is never overwritten. Each plugin records its own version too.</Feature>
          </ul>
          <p>
            <button className="welcome-link" onClick={onImportConnections}>Import connections now…</button>
          </p>
        </>
      ),
    },
    {
      id: "output",
      title: "Output panel",
      body: (
        <ul>
          <Feature title="One log, many channels">pick a channel from the drop-down — each plugin has a <em>Log</em> channel, and plugins add their own (for example <em>Keycloak — Requests</em>, <em>HTTP Client — Requests</em>).</Feature>
          <Feature title="Inspect">filter by text or level, follow new lines, click a line to expand details (request/response headers and bodies), and clear a channel.</Feature>
        </ul>
      ),
    },
    {
      id: "extend",
      title: "Plugins & extension model",
      body: (
        <ul>
          <Feature title="Everything is a plugin">the core has no infrastructure-specific code. A plugin is a folder with an <code>oneclient.json</code> manifest: connection types, explorer nodes, commands, views, themes, icons.</Feature>
          <Feature title="Two UI tiers">Tier 1 is declarative (generated connection forms, explorer trees, context menus). Tier 2 is a sandboxed web view for editors, grids and dashboards, with a small host API (commands, messaging, theme, open other views).</Feature>
          <Feature title="Plugins extend plugins">a plugin can declare an extension point and others contribute to it — for example the Files editor gets JSON, XML, Markdown and Text Tools features this way.</Feature>
          <Feature title="Compatibility">each plugin declares the plugin-API versions it supports (<code>engines.oneclient</code>); incompatible plugins are shown but never run. Plugins run in separate processes, so one crashing cannot take the app down.</Feature>
          <Feature title="Logging">plugins can create Output channels with <code>context.createOutputChannel(name)</code>.</Feature>
        </ul>
      ),
    },
    {
      id: "plugins",
      title: "What each plugin does",
      body: (
        <div className="doc-plugins">
          {plugins.length === 0 && <p className="doc-dim">No plugins are installed.</p>}
          {[...plugins]
            .sort((a, b) => (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id))
            .map((p) => {
              const features = PLUGIN_FEATURES[p.id];
              return (
                <div className="doc-plugin" key={p.id}>
                  <div className="doc-plugin-head">
                    <AssetIcon pluginId={p.id} icon={p.icon} size={20} />
                    <strong>{p.displayName ?? p.id}</strong>
                    <span className="doc-dim">v{p.version}</span>
                    <span className={`doc-state state-${p.state}`}>{STATE_LABEL[p.state] ?? p.state}</span>
                  </div>
                  {p.description && <p className="doc-dim">{p.description}</p>}
                  {features && (
                    <ul>
                      {features.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  )}
                  {p.error && <p className="doc-error">{p.error}</p>}
                </div>
              );
            })}
        </div>
      ),
    },
    {
      id: "keys",
      title: "Keyboard shortcuts",
      body: (
        <table className="doc-keys">
          <tbody>
            {(
              [
                ["Ctrl+P", "Search files, SQL objects and more across all connections"],
                ["Ctrl+Shift+F", "Find in Files (text search in an open folder)"],
                ["Ctrl+Shift+P", "Command Palette"],
                ["Ctrl+`", "Show / hide the bottom panel"],
                ["Ctrl+S", "Save (file editor, HTTP request, …)"],
                ["Ctrl+Enter", "Send the HTTP request"],
                ["F5 / Ctrl+Enter", "Run the SQL query (SQL Server)"],
                ["Shift+Alt+F", "Format document (file editor)"],
                ["Ctrl+Space", "Autocomplete suggestions (SQL, JSON editors)"],
              ] as const
            ).map(([k, d]) => (
              <tr key={k}>
                <td>
                  <Kbd>{k}</Kbd>
                </td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
    },
  ];

  const go = (id: string) => scroller.current?.querySelector(`#doc-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="welcome" ref={scroller}>
      <div className="welcome-hero">
        <Logo size={88} />
        <div>
          <h1>oneClient</h1>
          <p className="welcome-tagline">One client for everything.</p>
        </div>
      </div>

      <div className="welcome-actions">
        <button className="welcome-action primary" onClick={onNewConnection}>New connection</button>
        <button className="welcome-action" onClick={onImportConnections}>Import connections</button>
        <button className="welcome-action" onClick={onCommandPalette}>Command Palette <span className="doc-dim">Ctrl+Shift+P</span></button>
        <button className="welcome-action" onClick={onPlugins}>Plugins</button>
        <button className="welcome-action" onClick={onColorTheme}>Color theme</button>
        <button className="welcome-action" onClick={onIconTheme}>Icon theme</button>
      </div>

      <div className="doc">
        <h2 className="doc-title">Feature guide</h2>
        <p className="doc-dim">Everything oneClient can do today. The plugin section below is built from what is installed right now.</p>
        <nav className="doc-toc">
          {sections.map((s) => (
            <button key={s.id} className="welcome-link" onClick={() => go(s.id)}>
              {s.title}
            </button>
          ))}
        </nav>
        {sections.map((s) => (
          <section key={s.id} id={`doc-${s.id}`} className="doc-section">
            <h3>{s.title}</h3>
            {s.body}
          </section>
        ))}
      </div>
    </div>
  );
}
