# @oneclient/sql-core

The shared base of oneClient's SQL plugins (`oneclient-mssql`, `oneclient-postgres`, …). A plugin brings its
**dialect**: connection, query runner, metadata, highlighting and IntelliSense. The core brings everything that's the
same for every SQL database:

| Feature        | Backend (`@oneclient/sql-core`)                         | View (`@oneclient/sql-core/ui`)               |
| -------------- | ------------------------------------------------------- | --------------------------------------------- |
| Results grid   | —                                                       | sort (click a header), filter (`column:value`), range selection, Ctrl+C; `resultExport`: Export ▾ / copy as CSV, TSV, JSON, Markdown, SQL INSERTs; `cellViewer`: pretty JSON, long text |
| Safe mode      | —                                                       | `safeMode`: confirm UPDATE / DELETE without a real WHERE, DROP, TRUNCATE, ALTER … DROP before a script runs |
| Query windows  | `<prefix>.executeQuery` / `.cancelQuery`, the view hub  | `QueryWindow` (editor, toolbar, safe mode)    |
| Results        | streams runs to the panel, caches the latest per window | `ResultsPanel` (grids, messages, exports)     |
| History        | `<prefix>.history` / `.deleteHistory` / `.queryHistory` | the History side panel                        |
| FAST TOOLS     | the section's tree, `<prefix>.attach/detachFastToolsFolder` | —                                         |
| Create Database | `<prefix>.createDatabase` (name checked by the core; the dialect supplies `createDatabase(connectionId, name, options)`) | form on the Databases folder (from the manifest's `inputSchema`) |
| Fast Queries   | `<prefix>.newFastQuery` / `.runFastQuery` / `.runFastQueryOn` / `.saveFastQuery` / `.renameFastQuery` / `.deleteFastQuery` | ★ Save as Fast Query (Ctrl+S) |
| Fast Aggregates | `<prefix>.newFastAggregate` / `.renameFastAggregate` / `.deleteFastAggregate`, `<prefix>.aggregate` (the view's API) | the `<prefix>.aggregate` view (`Aggregate` in `@oneclient/sql-core/ui`) |

Every feature is on by default and can be turned off: on the backend with `createSqlCore({ features: { history, fastTools, fastQueries } })`,
in the views with `SqlDialectUi.features` (`history`, `fastQueries`, `safeMode`, `resultExport`, `cellViewer`). The grid, export,
cell viewer, history panel and safe-mode guard themselves live in `@oneclient/editor-kit/sql`. A plugin can also add its own Fast Tools (SQL Server adds
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

## Fast Aggregates

Right-click a table → **New Fast Aggregate…** and the table becomes the *root* of an editable aggregate: a paged list of its
rows; a row opens into a form with its children below — one-to-many tables as lists you can add to, edit and delete from,
many-to-many tables (through a join table) as links you add and remove — and each child opens the same way, so an Order,
its Items and the notes on each item are one screen. The configuration is a `*.aggregate.json` file in the connection's Fast
Tools folder, suggested from the database's foreign keys (join tables are recognised: two foreign keys covering the whole
key) and editable in the **Configure** panel — rename relations, drop the ones you don't need, pick the columns each list shows,
or edit the JSON.

A dialect turns it on by implementing the optional `TableAccess.foreignKeys(connectionId, database)`; reads and writes reuse the
table data editor's access (so edits are checked, one transaction, row-count verified). Filters that select a parent's children
are built from the configuration with every column name checked against the real table and every value typed as its column
(`aggregate/model.ts`), never from text typed in the view. Many-to-many relations need a single-column key on the related side.
