/** What the background-task view and backend share (type-only: the view bundle imports this file for its types). */

export type BackgroundState = "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface BackgroundTaskInfo {
  id: string;
  connectionId: string;
  /** The first meaningful line of the script. */
  title: string;
  sql: string;
  database: string | null;
  state: BackgroundState;
  /** Epoch ms. */
  startedAt: number;
  endedAt?: number | undefined;
  /** How long it ran (running: so far, as of this answer). */
  elapsedMs: number;
  /** Rows across all result sets, and rows affected by statements. */
  rows: number;
  resultSets: number;
  hasErrors: boolean;
  error?: string | undefined;
  /** After an app restart only the first rows of each result set are kept. */
  keptRows?: number | undefined;
}

export interface BackgroundResultSet {
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
  totalRows: number;
}

export interface BackgroundResult {
  resultSets: BackgroundResultSet[];
  messages: Array<{ kind: "info" | "error"; text: string; line?: number | undefined }>;
  rowsAffected: number;
  database: string | null;
}

export interface BackgroundTaskDetail extends BackgroundTaskInfo {
  result: BackgroundResult | null;
  /** The server's clock when this was answered: the view adds the time since (its own clock may differ). */
  serverNow: number;
}
