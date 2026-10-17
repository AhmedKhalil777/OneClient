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

// (globalThis guard: unit tests import the completion code outside a browser)
const params = new URLSearchParams(globalThis.location?.search ?? "");
export const connectionId = params.get("connectionId") ?? "";
/** Identifies this window's dedicated SQL session on the plugin side. */
export const windowId = params.get("windowId") ?? `w${Date.now()}`;
export const initialDatabase = params.get("database") ?? undefined;
export const initialSql = params.get("sql") ?? "";
export const autorun = params.get("autorun") === "1";

const invoke = <T,>(commandId: string, arg: Record<string, unknown>) =>
  window.oneclientView.invokeCommand(commandId, [{ connectionId, ...arg }]) as Promise<T>;

export const executeQuery = (opts: { queryId: string; sql: string; database?: string | undefined; lineOffset?: number }) =>
  invoke<QueryRun | { ok: false; error: string }>("postgres.executeQuery", { windowId, ...opts });
export const cancelQuery = (queryId: string) => invoke<{ ok: boolean }>("postgres.cancelQuery", { queryId });
export const listDatabases = () => invoke<string[]>("postgres.listDatabases", {});
export const serverInfo = () => invoke<ServerInfo>("postgres.serverInfo", {});
export const invokeCompletionCatalog = (database: string | undefined) =>
  invoke<import("./completion.js").Catalog>("postgres.completionCatalog", database ? { database } : {});
