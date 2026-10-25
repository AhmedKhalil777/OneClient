import type { SqlDialectUi } from "@oneclient/sql-core/ui";
import { createSqlCompletionProvider } from "./completion.js";
import { highlightSql } from "./highlight.js";

/** SQL Server for the shared query window and results panel (@oneclient/sql-core/ui). */
export const mssqlDialect: SqlDialectUi = {
  prefix: "mssql",
  productName: "SQL Server",
  gridDialect: "mssql",
  highlight: highlightSql,
  createCompletion: createSqlCompletionProvider,
  schemaChange: /\b(CREATE|ALTER|DROP|SELECT\s+[\s\S]*\bINTO|sp_rename)\b/i,
};
