import { createSqlApi, invoke } from "@oneclient/sql-core/ui";

/** SQL Server's calls from the query window; the shared ones (execute, history, fast queries…) come from the SQL core. */
const api = createSqlApi("mssql");
export const listDatabases = api.listDatabases;
export const invokeCompletionCatalog = (database: string | undefined) =>
  invoke<import("./completion.js").Catalog>("mssql.completionCatalog", database ? { database } : {});
