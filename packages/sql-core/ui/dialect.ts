import type { CompletionProvider } from "@oneclient/editor-kit";
import type { Dialect } from "@oneclient/editor-kit/sql";

/** What a SQL plugin tells the shared query window and results panel about its dialect. */
export interface SqlDialectUi {
  /** Id prefix of the plugin's commands and views ("mssql" → `mssql.executeQuery`, `mssql.results`). */
  prefix: string;
  /** "SQL Server", "PostgreSQL" — used in hints. */
  productName: string;
  /** Quoting and literals of the results panel's "copy as INSERT". */
  gridDialect: Dialect;
  /** SQL → syntax-highlighted HTML for the editor. */
  highlight(text: string): string;
  /** The editor's IntelliSense for the window's current database. */
  createCompletion(getDatabase: () => string | undefined): { provider: CompletionProvider; invalidate(): void };
  /** Scripts that change the catalog — after running one, IntelliSense reloads. */
  schemaChange: RegExp;
  /** Ctrl+Enter executes too (besides F5 / Ctrl+E). */
  ctrlEnterExecutes?: boolean;
  /** Tooltips of the database picker and Cancel button. */
  databaseTitle?: string;
  cancelTitle?: string;
  /**
   * What the plugin turned on in the core — all default to true. Mirror `SqlCoreOptions.features` for history and
   * fastQueries (the plugin must register the matching commands); the rest are view-only.
   */
  features?: SqlFeaturesUi;
}

export interface SqlFeaturesUi {
  /** ⟲ History panel (Ctrl+Shift+H): searchable per-connection history, re-run. Needs the core's history commands. */
  history?: boolean;
  /** ★ Save as Fast Query (Ctrl+S). Needs the core's fast query commands. */
  fastQueries?: boolean;
  /** Safe mode: confirm UPDATE / DELETE without WHERE, DROP, TRUNCATE before a script runs. */
  safeMode?: boolean;
  /** Results grid: Export ▾ and copy as CSV / TSV / JSON / Markdown / SQL INSERTs. (Sort, filter, selection, Ctrl+C always work.) */
  resultExport?: boolean;
  /** Results grid: the cell viewer (pretty JSON, long text, copy). */
  cellViewer?: boolean;
  /** Edit Data on tables (view `<prefix>.tableEditor`). Needs the core's table editor commands (`tableAccess`). */
  tableEditor?: boolean;
  /** Import CSV into a table (view `<prefix>.importCsv`). Needs the core's import commands. */
  importCsv?: boolean;
  /** Execution plans: ▤ Plan in the query window (view `<prefix>.plan`). Needs the core's `explain` command. */
  plan?: boolean;
}

/** The features with their defaults filled in. */
export function resolveFeatures(dialect: SqlDialectUi): Required<SqlFeaturesUi> {
  return { history: true, fastQueries: true, safeMode: true, resultExport: true, cellViewer: true, tableEditor: true, importCsv: true, plan: true, ...dialect.features };
}
