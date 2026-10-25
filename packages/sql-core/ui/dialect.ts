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
  /** FAST TOOLS → Fast Queries is on (the plugin registered the core's fast query commands). Default true. */
  fastQueries?: boolean;
}
