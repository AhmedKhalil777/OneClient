/**
 * What the core needs to know about a dialect's query run. Each plugin's runner returns more (columns, rows…), which
 * passes through to its results panel untouched.
 */
export interface QueryRunSummary {
  resultSets: ReadonlyArray<{ totalRows: number }>;
  messages: ReadonlyArray<{ kind: "info" | "error"; text: string }>;
  hasErrors: boolean;
  cancelled: boolean;
  elapsedMs: number;
  database: string | null;
  rowsAffected: number;
}

export interface ExecuteQueryRequest {
  connectionId: string;
  /** The query window: each one has its own session on the server. */
  windowId: string;
  queryId: string;
  database?: string | undefined;
  sql: string;
  /** Line in the editor where `sql` starts (for executing a selection). */
  lineOffset?: number | undefined;
}

export type ExecuteQuery = (request: ExecuteQueryRequest) => Promise<QueryRunSummary>;
