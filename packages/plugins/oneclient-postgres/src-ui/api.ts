import { invoke } from "@oneclient/sql-core/ui";

/** PostgreSQL's own calls from the query window; the shared ones (execute, history, fast queries…) come from the SQL core. */
export const invokeCompletionCatalog = (database: string | undefined) =>
  invoke<import("./completion.js").Catalog>("postgres.completionCatalog", database ? { database } : {});
