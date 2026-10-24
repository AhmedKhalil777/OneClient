// Mirrors the result types in ../src/query-runner.ts (the UI bundle can't import Node-side code).
export interface ResultColumn {
  name: string;
  type: string;
}
export interface ResultSet {
  columns: ResultColumn[];
  rows: unknown[][];
  totalRows: number;
}
export interface QueryMessage {
  kind: "info" | "error";
  text: string;
  line?: number;
}
export interface QueryRun {
  ok: true;
  resultSets: ResultSet[];
  messages: QueryMessage[];
  hasErrors: boolean;
  cancelled: boolean;
  elapsedMs: number;
  database: string | null;
  rowsAffected: number;
}
export interface ServerInfo {
  server: string;
  login: string;
  version: string;
}

const params = new URLSearchParams(location.search);
export const connectionId = params.get("connectionId") ?? "";
/** Identifies this window's dedicated SQL session on the plugin side. */
export const windowId = params.get("windowId") ?? `w${Date.now()}`;
export const initialDatabase = params.get("database") ?? undefined;
export const initialSql = params.get("sql") ?? "";
export const autorun = params.get("autorun") === "1";

const invoke = <T,>(commandId: string, arg: Record<string, unknown>) =>
  window.oneclientView.invokeCommand(commandId, [{ connectionId, ...arg }]) as Promise<T>;

export const executeQuery = (opts: { queryId: string; sql: string; database?: string | undefined; lineOffset?: number }) =>
  invoke<QueryRun | { ok: false; error: string }>("mssql.executeQuery", { windowId, ...opts });
export const cancelQuery = (queryId: string) => invoke<{ ok: boolean }>("mssql.cancelQuery", { queryId });
export const queryHistory = (search: string) => invoke<import("@oneclient/editor-kit/sql").HistoryEntry[]>("mssql.history", { search, limit: 300 });
export const deleteHistory = (id?: string) => invoke<{ ok: boolean }>("mssql.deleteHistory", id ? { id } : {});
export const openHistory = params.get("history") === "1";
export const listDatabases = () => invoke<string[]>("mssql.listDatabases", {});
export const serverInfo = () => invoke<ServerInfo>("mssql.serverInfo", {});
export const invokeCompletionCatalog = (database: string | undefined) =>
  invoke<import("./completion.js").Catalog>("mssql.completionCatalog", database ? { database } : {});
