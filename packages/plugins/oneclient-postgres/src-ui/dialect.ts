import type { SqlDialectUi } from "@oneclient/sql-core/ui";
import { createSqlCompletionProvider } from "./completion.js";
import { highlightSql } from "./highlight.js";

/** PostgreSQL for the shared query window and results panel (@oneclient/sql-core/ui). */
export const postgresDialect: SqlDialectUi = {
  prefix: "postgres",
  productName: "PostgreSQL",
  gridDialect: "postgres",
  highlight: highlightSql,
  createCompletion: createSqlCompletionProvider,
  schemaChange: /\b(CREATE|ALTER|DROP|SELECT\s+[\s\S]*\bINTO|RENAME|search_path)\b/i,
  ctrlEnterExecutes: true,
  databaseTitle: "Database — switching opens a new session (temp tables and SET options don't carry over)",
  cancelTitle: "Cancel executing query (Esc)",
};
