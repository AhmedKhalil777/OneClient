import type { SqlDialectUi } from "@oneclient/sql-core/ui";
import { createSqlCompletionProvider } from "./completion.js";
import { highlightSql } from "./highlight.js";

/** MySQL / MariaDB for the shared query window and results panel (@oneclient/sql-core/ui). */
export const mysqlDialect: SqlDialectUi = {
  prefix: "mysql",
  productName: "MySQL",
  gridDialect: "mysql",
  highlight: highlightSql,
  createCompletion: createSqlCompletionProvider,
  schemaChange: /\b(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i,
  ctrlEnterExecutes: true,
  databaseTitle: "Database — USE for this window's session",
  cancelTitle: "Cancel executing query (Esc)",
};
