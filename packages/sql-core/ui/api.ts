import type { HistoryEntry } from "@oneclient/editor-kit/sql";

// Mirrors the result types of the plugins' query runners (the UI bundle can't import Node-side code).
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

// (globalThis guard: unit tests import completion code outside a browser)
const params = new URLSearchParams(globalThis.location?.search ?? "");
export const connectionId = params.get("connectionId") ?? "";
/** Identifies this window's dedicated SQL session on the plugin side. */
export const windowId = params.get("windowId") ?? `w${Date.now()}`;
export const initialDatabase = params.get("database") ?? undefined;
export const initialSql = params.get("sql") ?? "";
export const autorun = params.get("autorun") === "1";
export const openHistory = params.get("history") === "1";
/** Set when the window edits a saved fast query (opened from FAST TOOLS). */
export const initialFastQuery = params.get("fastQueryFile")
  ? { file: params.get("fastQueryFile")!, name: params.get("fastQueryName") ?? "", anyDatabase: params.get("fastQueryAnyDatabase") === "1" }
  : null;

export const invoke = <T,>(commandId: string, arg: Record<string, unknown>) =>
  window.oneclientView.invokeCommand(commandId, [{ connectionId, ...arg }]) as Promise<T>;

/** The query window's calls into its plugin's backend (`<prefix>.executeQuery`, …). */
export function createSqlApi(prefix: string) {
  const call = <T,>(id: string, arg: Record<string, unknown> = {}) => invoke<T>(`${prefix}.${id}`, arg);
  return {
    executeQuery: (opts: { queryId: string; sql: string; database?: string | undefined; lineOffset?: number }) => call<QueryRun | { ok: false; error: string }>("executeQuery", { windowId, ...opts }),
    cancelQuery: (queryId: string) => call<{ ok: boolean }>("cancelQuery", { queryId }),
    queryHistory: (search: string) => call<HistoryEntry[]>("history", { search, limit: 300 }),
    deleteHistory: (id?: string) => call<{ ok: boolean }>("deleteHistory", id ? { id } : {}),
    listDatabases: () => call<string[]>("listDatabases"),
    serverInfo: () => call<ServerInfo>("serverInfo"),
    runInBackground: (q: { sql: string; database?: string | undefined }) => call<{ ok: true; id: string; title: string } | { ok: false; error: string }>("runInBackground", q),
    saveFastQuery: (q: { file?: string | undefined; name: string; sql: string; database?: string | undefined }) =>
      call<{ ok: true; file: string; name: string } | { ok: false; error: string }>("saveFastQuery", q),
  };
}

export type SqlApi = ReturnType<typeof createSqlApi>;
