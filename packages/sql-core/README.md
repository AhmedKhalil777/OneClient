# @oneclient/sql-core

The shared base of oneClient's SQL plugins (`oneclient-mssql`, `oneclient-postgres`, …). A plugin brings its
**dialect**: connection, query runner, metadata, highlighting and IntelliSense. The core brings everything that's the
same for every SQL database:

| Feature        | Backend (`@oneclient/sql-core`)                         | View (`@oneclient/sql-core/ui`)               |
| -------------- | ------------------------------------------------------- | --------------------------------------------- |
| Query windows  | `<prefix>.executeQuery` / `.cancelQuery`, the view hub  | `QueryWindow` (editor, toolbar, safe mode)    |
| Results        | streams runs to the panel, caches the latest per window | `ResultsPanel` (grids, messages, exports)     |
| History        | `<prefix>.history` / `.deleteHistory` / `.queryHistory` | the History side panel                        |
| FAST TOOLS     | the section's tree, `<prefix>.attach/detachFastToolsFolder` | —                                         |
| Fast Queries   | `<prefix>.newFastQuery` / `.runFastQuery` / `.runFastQueryOn` / `.saveFastQuery` / `.renameFastQuery` / `.deleteFastQuery` | ★ Save as Fast Query (Ctrl+S) |

Every feature is on by default and can be turned off. A plugin can also add its own Fast Tools (SQL Server adds
Fakers). User-facing docs: [docs/FAST-TOOLS.md](../../docs/FAST-TOOLS.md).

## Using it in a plugin

Backend (`src/main.ts`):

```ts
const core = createSqlCore({
  prefix: "postgres",               // command / view / node type ids: postgres.executeQuery, postgres.query, …
  executeQuery,                     // (request) => Promise<QueryRun>
  cancelQuery,
  ensureConnected: (id) => void requireSession(id),
  describeError,
  features: { fastQueries: true },  // history, fastTools, fastQueries: all default true
  tools: [],                        // the plugin's own Fast Tools (FastTool), e.g. SQL Server's fakerTool
});
context.registerExplorerProvider(createExplorerProvider(core.fastTools)); // route core.fastTools.nodeTypes to it
context.registerView("postgres.query", core.views.query);
context.registerView("postgres.results", core.views.results);
for (const h of [...core.commands, ...createCommandHandlers(core)]) context.registerCommand(h);
```

The plugin's own commands use `core.queryWindow(...)` to open query tabs and `core.action(...)` for error handling.

Views (`src-ui/main.tsx`, `results-main.tsx`): describe the dialect once and render the shared components:

```tsx
const dialect: SqlDialectUi = { prefix: "postgres", productName: "PostgreSQL", gridDialect: "postgres", highlight: highlightSql, createCompletion, schemaChange: /\b(CREATE|ALTER|DROP)\b/i };
<QueryWindow dialect={dialect} />   // and <ResultsPanel dialect={dialect} />, with "@oneclient/sql-core/ui/styles.css"
```

The plugin's views still need their own `src-ui/global.d.ts` (the `window.oneclientView` declaration).

### Manifest

Manifests are static, so a plugin declares in `oneclient.json` what it turns on: the `<prefix>.query` and
`<prefix>.results` views, the core's commands (with their `when` clauses), and for FAST TOOLS:

- `explorerSections`: `{ "id": "fastTools", "title": "Fast Tools", "rootNodeType": "<prefix>.fastToolsRoot", "connectionType": "<type>" }`
- `explorerNodes`: `<prefix>.fastToolsRoot`, `.fastQueriesRoot`, `.fastQueryGroup`, `.fastQuery`, plus the root node of each of the plugin's own tools.

Copy the entries from `oneclient-postgres/oneclient.json` and change the prefix.

## Adding a Fast Tool

A `FastTool` is a folder in FAST TOOLS: `rootNodeType`, the node types below it that have children, and
`children(connectionId, folder, node)`. Its files live in the attached folder (`findFiles`, `inFolder` and `freeName`
help). A tool for every dialect goes into `createSqlCore`. A dialect-specific one is passed in `tools`.
