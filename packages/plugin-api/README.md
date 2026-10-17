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
  manifest.ts     PluginManifest + contribution types (oneclient.json shape)
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
↑/↓ previews, Enter keeps, Esc reverts. The dev fixture plugin
(`packages/core/dev-plugins/oneclient-sample`) ships one of each as a working example.
