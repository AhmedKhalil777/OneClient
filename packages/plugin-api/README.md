# @oneclient/plugin-api

The **only** package oneClient plugins are allowed to import. It has zero
runtime dependencies and exports TypeScript interfaces/types plus a few tiny
helpers (`PLUGIN_API_VERSION`, and the theme helpers in `theme.ts`). Everything plugins see — connection
providers, explorer tree providers, command handlers, the Tier 1 form/grid
descriptors, the Tier 2 view-host contract, and the `PluginContext` passed to
`activate()` — lives here.

See [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for how these interfaces
fit into the rest of the app, and
[`schema/oneclient-manifest.schema.json`](./schema/oneclient-manifest.schema.json)
for the `oneclient.json` manifest format (mirrors `src/manifest.ts` by hand —
keep both in sync when either changes).

## Layout

```
src/
  version.ts      PLUGIN_API_VERSION
  json-schema.ts  Minimal JSON Schema + UiSchema types for Tier 1 forms
  logging.ts      Logger
  secrets.ts      SecretStore
  connection.ts   ConnectionProvider / ConnectionHandle / ConnectionContext
  explorer.ts     ExplorerProvider / TreeNode / ExplorerContext
  commands.ts     CommandHandler / CommandContext
  ui.ts           Tier 1 TableResult/ColumnDescriptor; Tier 2 ViewHostApi/ViewMessageHandler
  completion.ts   CompletionProvider / CompletionItem (autocomplete; UI in @oneclient/editor-kit)
  theme.ts        Color/icon theme contributions, ThemeState, THEME_COLOR_KEYS, icon helpers
  manifest.ts     PluginManifest + contribution types (oneclient.json shape), incl. title bar menus
  workspace.ts    Workspace / WorkspaceFolder: the folders open in core's Explorer (context.workspace)
  context.ts      PluginContext, PluginModule (activate/deactivate)
  index.ts        public exports
schema/
  oneclient-manifest.schema.json   JSON Schema for oneclient.json
test/
  manifest-schema.test.ts          validates fixtures/ against the schema
```

## Why no implementation lives here

This package is pure contract. The core (Phase 2) implements the other half
of every interface above (the registries, the IPC marshalling, the generic
form/grid renderers, the view host). Reference plugins (Phase 3/4) are the
first real consumers.

## Naming your connections

Core calls a saved connection a "Connection" unless the connection type says otherwise. Name it after what it
is, so the sidebar reads *Servers*, *Folders* or *Clusters*, and the menus say *Add Server* and *Remove Server*:

```json
"connectionTypes": [{ "id": "postgres", "label": "PostgreSQL", "connectionLabel": "Server" }]
```

`connectionLabelPlural` overrides the plural when appending "s" is wrong (e.g. `"connectionLabel": "Repository", "connectionLabelPlural": "Repositories"`).

## Themes & icons

oneClient follows VS Code's model: core owns a set of **color keys** and a set
of **icon ids**; themes give them values; plugins use them instead of
hard-coding colors and shipping their own copies of common icons.

### Using colors in a plugin view

Every color key in `THEME_COLOR_KEYS` (`editor.background`, `sideBar.background`,
`list.hoverBackground`, `syntax.keyword`, `terminal.ansiRed`, …) is injected into
every Tier 2 view as a CSS variable: dots become dashes, prefixed `--oc-`.

```css
.my-grid { background: var(--oc-editor-background, #1e1e1e); color: var(--oc-foreground, #ccc); }
.my-grid tr:hover { background: var(--oc-list-hoverBackground, #2a2d2e); }
```

Nothing to wire up: the variables are set before your code runs and updated
live when the user switches theme. For values in JS (canvas, xterm.js) use
`window.oneclientView.getTheme()` / `onThemeChange()` (or `useTheme()` from
`@oneclient/editor-kit/react`). `@oneclient/editor-kit/theme.css` gives views
the standard scrollbars and body colors.

### Using icons

Anywhere an icon is accepted — `TreeNode.icon`, a manifest view/connection
type `icon` — write `$(id)` to use an icon from the registry instead of a file:

```ts
{ id: "orders", label: "dbo.Orders", nodeType: "mssql.table", icon: "$(table)", … }
```

Built-in ids: `folder folder-opened file file-code files server database table
view column key index function procedure terminal results output plug
extensions gear search play stop refresh add close trash ellipsis
chevron-right chevron-down chevron-up split-horizontal color-mode symbol`.
They're monochrome and drawn in the surrounding text color, so they follow the
theme. In a view, render one with `<Icon id="table" />` from
`@oneclient/editor-kit/react` (or `iconUrl(id)` as a CSS mask).

### Contributing

```jsonc
"contributes": {
  // New icon ids any plugin can use as $(id). Built-in ids can't be taken over.
  "icons": [{ "id": "docker-container", "path": "icons/container.svg", "colored": true }],

  // Color themes: { "colors": { "<key>": "#rrggbb", … } }; unset keys fall back to the built-in theme of `uiTheme`.
  "themes": [{ "id": "solarized-dark", "label": "Solarized Dark", "uiTheme": "dark", "path": "themes/solarized.json" }],

  // Icon themes: { "icons": { "<icon id>": "file.svg" | { "path": "file.svg", "colored": true } } },
  // paths relative to the theme file; ids it doesn't list keep their default.
  "iconThemes": [{ "id": "colorful", "label": "Colorful", "path": "icon-theme/icon-theme.json" }]
}
```

Users pick themes with **Preferences: Color Theme…** / **Preferences: Icon
Theme…** (command palette, or the gear at the bottom of the activity bar);
↑/↓ previews, Enter keeps, Esc reverts. The Miscellaneous plugin
(`packages/plugins/oneclient-misc`) ships an icon theme as a working example.

### File & folder icons

An icon theme can also map **file extensions, file names and folder names** to
icons, like VS Code's Seti and Material Icon themes. The theme file
(`contributes.iconThemes[].path`) is `IconThemeFile`:

```jsonc
{
  "colored": true,                                  // the icons below are multi-colour
  "icons": { "x-ts": "icons/ts.svg", "x-file": "icons/file.svg", "x-folder": "icons/folder.svg", … },
  "file": "x-file", "folder": "x-folder", "folderExpanded": "x-folder-open",   // fallbacks
  "fileExtensions": { "ts": "x-ts", "spec.ts": "x-test-ts" },   // longest match wins: a.spec.ts → "spec.ts" → "ts"
  "fileNames": { "package.json": "x-node", "dockerfile": "x-docker" },        // beat extensions; lower-case
  "folderNames": { "src": "x-src" },                // ".src", "_src", "__src__" match too
  "folderNamesExpanded": { "src": "x-src-open" },
  "light": { "fileExtensions": { "ts": "x-ts-light" } },        // overrides in light color themes
  "hc": { … }                                                    // …and in high-contrast ones
}
```

Mappings that point at an id the theme doesn't define are ignored. The
**Material Icon Theme** plugin (`packages/plugins/oneclient-misc`,
1,300+ extensions, 2,000+ file names) is contributed declaratively (`contributes.iconThemes`, no code) by the built-in
Miscellaneous plugin, and is the default icon theme when the user hasn't chosen one.

**Using it from a plugin.** A tree node that is a file or folder says so, and core
picks the icon from the active theme (by name, then extension), falling back to
the node's own `icon`:

```ts
{ id: path, label: name, nodeType: "files.file", icon: "$(file)", resource: { name, kind: "file" } }
```

Editor tabs opened from such a node show the same icon. Plugin *views* don't
receive the mapping table (thousands of entries); `resolveFileIcon()` is exported
for code that has the table.

## Extending other plugins

A plugin can contribute to another plugin's **extension point**. Core only brokers
them — the manifest names the point (`<owning plugin id>.<name>`; core's own points are `oneclient.<name>`), the owner
defines what an item looks like and what to do with it:

```jsonc
"contributes": {
  "extensions": {
    "oneclient.editors": [ { "id": "json", "label": "JSON", "extensions": ["json"], … } ]
  }
}
```

A view reads what others contributed with `window.oneclientView.getContributions(point)`
(each item tagged with its `pluginId`, which can't be spoofed). Any plugin can define
points of its own the same way.

### The file editor: `oneclient.editors`

Core's file editor knows nothing about JSON, XML or Markdown. Plugins teach it,
per file type (or for every file with `"extensions": ["*"]`). Types are in `src/file-editor.ts`.

| Feature | Command receives → returns | Gives the editor |
|---|---|---|
| `format` | `TransformRequest` → `TransformResult` | the **Format** button and Shift+Alt+F |
| `symbols` | `FileEditorRequest` → `SymbolsResult` | **breadcrumbs**: the nesting around the cursor, with sibling dropdowns |
| `tokens` | `FileEditorRequest` → `TokensResult` | syntax highlighting (flat `start, end, class` triples) |
| `preview` | `FileEditorRequest` → `PreviewResult` | a live **Preview** pane (HTML in a script-less sandboxed frame) |
| `actions[]` | `TransformRequest` → `TransformResult` | entries in the **Actions** menu (sort lines, minify, …) |

Each feature names a command of the contributing plugin (mark them `"hidden": true` so they stay out of
the command palette). They run in that plugin's own extension host, so a slow or broken language plugin
can't hang the editor. Text always arrives with `\n` line endings.

When several plugins match a file, the most specific contribution (file name › longest extension › `*`)
wins each single-valued feature, and `actions` are combined — so one plugin can format `.json` while another
adds "Sort Lines" to every file.

```jsonc
// oneclient-misc/oneclient.json (abridged)
"commands": [{ "id": "json.format", "title": "JSON: Format Document", "hidden": true }, …],
"extensions": {
  "oneclient.editors": [{
    "id": "json", "label": "JSON",
    "extensions": ["json", "jsonc"], "fileNames": [".babelrc"],
    "format": "json.format", "symbols": "json.symbols", "tokens": "json.tokens",
    "actions": [{ "id": "minify", "label": "Minify JSON", "command": "json.minify" }]
  }]
}
```
```ts
// oneclient-misc/src/main.ts (abridged)
context.registerCommand({ commandId: "json.format", execute: ([req]) => formatJson(req.text, req.tabSize, req.insertSpaces) });
```

Built-in example: `oneclient-misc` contributes five editors to the point from one plugin — JSON (format, minify, breadcrumbs,
highlighting), XML (format, element breadcrumbs, highlighting), SQL (format, statement outline, highlighting,
keyword case), Markdown (heading outline, highlighting, preview with code
highlighting and task lists) and text utilities (wildcard actions).

## Output channels (the Output panel)

The shell has one bottom-panel tab, **Output**, with a channel picker (like VS Code). Any plugin can write to it:

```ts
export async function activate(context: PluginContext) {
  const tasks = context.createOutputChannel("Tasks");
  tasks.info("Started sync");
  tasks.error("Sync failed", err.stack); // optional 2nd argument = expandable detail
  tasks.show(); // open the panel on this channel
}
```

- Channels are listed as "Plugin name — channel name". Every plugin also gets a **Log** channel fed by `context.logger`.
- Entries live in memory only (most recent ~2000 per channel); users can filter by text and level, follow, and clear.
- Don't log secrets. (The Keycloak plugin's **Requests** channel masks passwords, tokens and client secrets.)

## Global search providers (the top search bar)

The shell's search bar (Ctrl+P) asks every plugin that declares a search provider, in parallel, as the user types:

```jsonc
// oneclient.json
"contributes": {
  "commands": [{ "id": "files.search", "title": "Files: Search by Name", "hidden": true }],
  "searchProviders": [{ "id": "files", "label": "Files", "command": "files.search", "connectionType": "folder", "order": 10 }]
}
```

```ts
// the command: SearchRequest → SearchResult[]
context.registerCommand({
  commandId: "files.search",
  async execute([req]: [SearchRequest]): Promise<SearchResult[]> {
    return findThings(req.connectionId, req.query, req.limit).map((t) => ({
      id: t.path, // same id as the explorer node → opens the same tab
      label: t.name,
      description: t.dir,
      resource: { name: t.name, kind: "file" }, // icon comes from the icon theme
      openView: { viewId: "files.editor", params: { path: t.path } }, // …or: command: { id: "sql.selectTop", args: { … } }
    }));
  },
});
```

Core calls the command once per saved connection of the plugin (connecting it first, with a timeout), validates and caps
what comes back, and shows it in a group labelled with `label`. A result either opens one of the plugin's views
(`openView`) or runs a command (`command`; the argument is `{ connectionId, ...args }` and an `openNode` in its result is opened,
exactly like an explorer context-menu command). Failures show up as a hint under the results and never block other providers.

## The workspace (folders open in the Explorer)

The Explorer, the file editor, Search and the Terminal are part of **core**, not plugins
(`packages/core/src/main/workspace`, `src/main/terminal`, `src/renderer/views`). The folders the user opens in the Explorer are the *workspace*, and
every plugin can use it instead of building its own file handling:

```ts
export async function activate(context: PluginContext) {
  // List the open folders (absolute paths) and follow changes.
  const folders = await context.workspace.getFolders();
  context.subscriptions.push(context.workspace.onDidChangeFolders((next) => rescan(next)));

  // Open a file in core's editor (with every editor feature other plugins contribute), at a line.
  await context.workspace.openFile("C:/src/app/queries/report.sql", { line: 12, column: 5, length: 6 });
}
```

From a Tier 2 view: `await window.oneclientView.openFile(path, { line })` (resolves `false` when the file isn't
inside an open folder). The built-in Terminal uses this to start new terminals in the first workspace folder.

## Title bar menus

Core draws a VS Code-style menu bar (File, Edit, View, Go, Run, Terminal, Help). Plugins add items with
`contributes.menus`: an item either runs one of the plugin's `command`s, or — with only a `keybinding` — presses
that key in the active editor tab when it is one of the plugin's own views, so a menu item can trigger what the
view already does on a shortcut:

```json
"menus": [
  { "menu": "run", "title": "Execute Query", "keybinding": "F5", "when": "activeView == 'postgres.query'", "group": "1_run" },
  { "menu": "run", "title": "Cancel Query", "keybinding": "Escape", "when": "activeView == 'postgres.query'", "group": "1_run" },
  { "menu": "help", "title": "Redis Commands Reference", "command": "redis.openDocs" }
]
```

`when` takes `activeView` (view id of the active editor tab) and `activePlugin`, with the usual operators —
`==`, `!=`, `=~ /re/`, `!`, `&&`, `||` and parentheses. Items with the same `group` sit together. The **Run** menu
is only made of these items (core has nothing to run by itself), so plugins with something runnable should add one.
