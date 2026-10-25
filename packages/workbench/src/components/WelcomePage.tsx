import { type ReactNode, useRef } from "react";
import type { PluginSummary } from "@oneclient/backend/shared/types.js";
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
  "oneclient-misc": [
    "JSON: format and minify, breadcrumbs with the path at the cursor, syntax highlighting (.json, .jsonc, .geojson, .har, .webmanifest and well-known config files).",
    "XML: format, element-path breadcrumbs, syntax highlighting (.xml, .csproj, .config, .svg, .xaml, .resx, .nuspec and many more).",
    "SQL (.sql, .tsql, .ddl…): syntax highlighting, an outline of statements and CREATE objects in the breadcrumbs, a formatter (one clause per line, one column per line, upper-case keywords) and Uppercase / Lowercase Keywords actions.",
    "Markdown: live preview next to the source, heading outline in the breadcrumbs, syntax highlighting.",
    "Text utilities for every file: sort lines (ascending / descending), remove duplicate lines, trim trailing whitespace, ensure a final newline — on the selection when there is one.",
    "Material Icon Theme: the default file and folder icons in the explorer — 1,300+ file types, 2,000+ special file names and well-known folders (switch via Preferences: Icon Theme).",
  ],
  "oneclient-docker": ["Connect to a local or remote Docker Engine.", "Browse containers, images, volumes and networks; start, stop, restart and remove containers; pull images."],
  "oneclient-mssql": [
    "Connect to Microsoft SQL Server — an object explorer (databases, tables, views, procedures, functions…) and a query editor with result grids, like a small SSMS.",
    "IntelliSense: keywords, table and column names, and schema objects.",
    "Top search: type part of a table, view, procedure or function name to jump straight to it from any screen.",
    "FAST TOOLS section: attach a folder to a connection (keep it in a repo) for reusable developer tools — Fast Queries (save any script with ★ Save as Fast Query, Ctrl+S, for one database or any; run it again in one click; plain *.query.sql files) and Fakers.",
    "Fakers (Bogus-style fake data, in FAST TOOLS): *.faker.json files; create fakers per table with generators suggested from column names and types; nest child rows (e.g. 1–3 orders per customer, 2–4 lines per order) and let foreign keys create their parent rows; preview, then insert everything in one transaction. Files are plain JSON — keep them in a repo. Format: docs/FAKERS.md.",
    "Script tables as CREATE, select top 1000 rows, script procedures as EXECUTE; run and cancel queries; results and messages in the Query Results panel.",
  ],
  "oneclient-keycloak": [
    "Manage realms, users, groups, roles, clients, client scopes, identity providers, sessions and events.",
    "Edit any resource as JSON with formatting and breadcrumbs; create users with passwords, reset passwords, enable/disable, log out, unlock.",
    "Role mappings and group membership for users and groups; client secrets, installation config, realm export.",
    "Developer tools: get tokens (password, client-credentials, refresh), decode JWTs, introspect, UserInfo, evaluate what a client would receive.",
    "Every request is logged to the Output panel (secrets masked).",
  ],
  "oneclient-azure-blob": [
    "Connect with a connection string, account name + key, a SAS URL (account or container) or the local Azurite emulator.",
    "Explorer: containers → folders → blobs (with file-type icons). Create / delete containers and folders, set public access.",
    "Blob view: preview and edit text / JSON / XML in the shared editor (saving keeps content type and metadata and refuses to overwrite someone else's change), image preview, properties, headers, metadata, access tier, rename / copy, download, and SAS links.",
    "Browser (⊞): one folder at a time with breadcrumbs — upload by picker or drag & drop, multi-select download / delete, new folder, container SAS. Containers and blob paths show up in the top search.",
  ],
  "oneclient-postgres": [
    "Connect with host / port / user or a postgres:// connection string, with SSL (require or verify) — works with Azure, RDS, Supabase and Neon.",
    "Explorer: databases → schemas → tables, views, materialized views, functions (with overloads), procedures and sequences; columns, indexes and constraints.",
    "Query windows, each its own session: run the selection or the whole script (F5 / Ctrl+Enter), many result sets, RAISE NOTICE output, psql-style errors with the line, cancel (Esc), IntelliSense that follows search_path and quotes \"MixedCase\" names.",
    "Scripts: Select Top 1000, Count Rows, CREATE TABLE (constraints, FKs, indexes), INSERT, CREATE OR REPLACE for views / functions / procedures, SELECT / CALL with named parameters. Objects of every database show up in the top search.",
    "FAST TOOLS section: attach a folder to a connection and save scripts as Fast Queries (★ Save as Fast Query, Ctrl+S) — for one database or any, run again in one click; plain *.query.sql files you can keep in a repo.",
  ],
  "oneclient-kafka": [
    "Connect to any Kafka cluster (Apache Kafka, Redpanda, Confluent Cloud, Event Hubs) with bootstrap servers, SASL PLAIN / SCRAM and TLS.",
    "Explorer: brokers, topics and consumer groups. Create topics, increase partitions, empty or delete a topic, delete a group.",
    "Topic view: browse messages from the newest, the beginning, an offset or a date/time (per partition, filterable, without committing offsets), with pretty JSON, keys and headers; produce messages with key, headers and partition; partitions with leaders, ISR and offsets; edit configuration overrides.",
    "Consumer group view: members and their assignments, committed offsets and lag per partition with auto-refresh, and offset resets (earliest, latest, date/time). Cluster dashboard (⊞); topics and groups show up in the top search.",
  ],
  "oneclient-redis": [
    "Connect to Redis (password, ACL user, TLS, any database); the explorer lists databases with key counts, then keys grouped by namespace (user:1:profile → user › 1 › profile).",
    "Key editor for every type: strings (pretty JSON with the file-editor smarts), hashes, lists, sets, sorted sets and streams — add, edit and delete items; TTL, rename, delete.",
    "Dashboard (⊞): key browser with pattern / type filters and bulk delete, a CLI with history and redis-cli style output, server info and the slow log. Keys show up in the top search; writes are logged to the Output panel.",
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
          <Feature title="Title bar & menus">File, Edit, View, Go, Run, Terminal and Help — like VS Code (open one with <Kbd>Alt</Kbd>+its letter, then the arrow keys). <em>File</em>: new file, open / close folders, save, close editors, import / export connections, preferences. <em>Edit</em>: undo / redo, clipboard, find / replace in the editor and in files. <em>View</em>: every sidebar and panel, appearance (side bar, panel, full screen, zoom). <em>Go</em>: go to file or line, switch editors. <em>Run</em>: whatever the active editor runs (Execute Query, Send Request…) — plugins add their own items. <em>Help</em>: this guide, keyboard shortcuts, logs, About.</Feature>
          <Feature title="Explorer (core)">the first activity-bar icon (<Kbd>Ctrl+Shift+E</Kbd>): the folders you open (<em>File ▸ Open Folder…</em>, <Kbd>Ctrl+O</Kbd>) as trees with real file-type icons; create, rename and delete files and folders, open a terminal there. Files open in the shared editor. The open folders are the <strong>workspace</strong> — plugins can list them and open files in the editor too.</Feature>
          <Feature title="Search (core)">the second icon (<Kbd>Ctrl+Shift+F</Kbd>): find text in every open folder — match case, whole word, regular expressions, files to include / exclude — results grouped per file (and per folder); click one to open the file with the match selected. Replace per file or everywhere (<Kbd>Ctrl+Shift+H</Kbd>).</Feature>
          <Feature title="Source Control (core)">the third icon (<Kbd>Ctrl+Shift+G</Kbd>), like VS Code: per repository a commit box (<Kbd>Ctrl+Enter</Kbd>) with Commit / Amend / Commit &amp; Push / Commit &amp; Sync, the Merge, Staged and Changes groups (stage <strong>+</strong>, unstage <strong>−</strong>, discard <strong>↶</strong>, click for a side-by-side or inline diff), checkout and create branches, pull / push / fetch / sync, and a <strong>Graph</strong> of the history with branch lanes and refs (click a commit for its files and diffs). The status bar shows the branch and ahead / behind. It uses your own <code>git</code>, so hooks, credentials and config just work.</Feature>
          <Feature title="Tasks (core)"><em>Terminal ▸ Run Task…</em> (<Kbd>Ctrl+Shift+B</Kbd> for the build task) runs <code>package.json</code> scripts, <code>.vscode/tasks.json</code> / <code>.oneclient/tasks.json</code> tasks and .NET builds / tests as background tasks. They — and Git's fetch / pull / push, and plugins' long jobs — show in the status bar and the <strong>Tasks</strong> panel with live output, progress, Stop and Run Again.</Feature>
          <Feature title="Editor">format (<Kbd>Shift+Alt+F</Kbd>), breadcrumbs, highlighting and preview from plugins; <strong>Find / Replace</strong> (<Kbd>Ctrl+F</Kbd> / <Kbd>Ctrl+H</Kbd>, <Kbd>F3</Kbd> for the next match) with every match marked, and <strong>Go to Line</strong> (<Kbd>Ctrl+G</Kbd>) — in files and in SQL query windows.</Feature>
          <Feature title="Terminal (core)">PowerShell, Command Prompt, Git Bash, WSL, bash / zsh in the bottom panel; <em>Terminal ▸ New Terminal</em> (<Kbd>Ctrl+Shift+`</Kbd>) starts in your first open folder.</Feature>
          <Feature title="Activity bar">then one icon per plugin; click to open that plugin’s sidebar. Click the active one again (or <Kbd>Ctrl+B</Kbd>) to hide the sidebar.</Feature>
          <Feature title="Sidebar">each plugin lists its saved servers, clusters or accounts (use <strong>+</strong> to add one) with their explorer trees; plugins can add more sections (like the SQL plugins' <em>Fast Tools</em>). Right-click any node for its commands; clicking a leaf opens it in an editor tab. Nothing is fetched until you expand it.</Feature>
          <Feature title="Editor tabs">requests, tables, editors and dashboards open as tabs (● marks unsaved changes and asks before closing). The ⊞ button on a connection opens its dashboard.</Feature>
          <Feature title="Bottom panel">Terminal, plugin result panels (for example SQL Query Results) and the <strong>Output</strong> log share one panel with an icon navigator. Toggle it with <Kbd>Ctrl+`</Kbd> or the Panel button in the status bar; drag its top edge to resize.</Feature>
          <Feature title="Search everything">the bar at the top (or <Kbd>Ctrl+P</Kbd>) searches <em>all</em> your connections at once. Every plugin that offers search answers in its own group: the Explorer finds file names in your open folders (nested, fuzzy — "pm" finds plugin-manager.ts), the SQL Server plugin finds tables, views, procedures and functions across the databases and opens them directly. Results appear as each plugin answers; a slow or unreachable connection never blocks the rest.</Feature>
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
          <Feature title="A small core, everything else is a plugin">the core is the workbench — Explorer, Search, editor, Terminal, menus, Output — and has no infrastructure-specific code. A plugin is a folder with an <code>oneclient.json</code> manifest: connection types, explorer nodes, commands, views, menu items, themes, icons.</Feature>
          <Feature title="Shared workspace">plugins reach the folders open in the Explorer through <code>context.workspace</code> (list them, follow changes, open a file in the editor at a line) instead of building their own file handling.</Feature>
          <Feature title="Two UI tiers">Tier 1 is declarative (generated connection forms, explorer trees, context menus). Tier 2 is a sandboxed web view for editors, grids and dashboards, with a small host API (commands, messaging, theme, open other views).</Feature>
          <Feature title="Plugins extend plugins">a plugin can declare an extension point and others contribute to it — for example the file editor gets JSON, XML, Markdown and Text Tools features this way.</Feature>
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
          {plugins
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
                ["Ctrl+Shift+F / Ctrl+Shift+H", "Search / replace in the open folders"],
                ["Ctrl+Shift+P", "Command Palette"],
                ["Alt+letter", "Open a title bar menu (Alt+F = File …)"],
                ["Ctrl+Shift+E / Ctrl+B", "Explorer / show-hide the side bar"],
                ["Ctrl+Shift+G", "Source Control (commit with Ctrl+Enter)"],
                ["Ctrl+Shift+B", "Run the build task"],
                ["Ctrl+O / Ctrl+N", "Open a folder / new file"],
                ["Ctrl+F / Ctrl+H / Ctrl+G", "Find, replace, go to line (editor and SQL windows)"],
                ["Ctrl+`", "Show / hide the bottom panel"],
                ["Ctrl+Shift+`", "New terminal"],
                ["Ctrl+W / Ctrl+PageDown", "Close the editor / next editor"],
                ["Ctrl+= / Ctrl+- / Ctrl+0", "Zoom in / out / reset"],
                ["Ctrl+S", "Save (file editor, HTTP request, …)"],
                ["Ctrl+Enter", "Send the HTTP request"],
                ["F5 / Ctrl+Enter", "Run the SQL query (SQL Server, PostgreSQL)"],
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
