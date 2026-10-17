import sql from "mssql";
import { quoteIdent } from "./config.js";
import { sqlErrorInfo } from "./errors.js";
import { windowPool } from "./sessions.js";

/** Rows kept per result set; the rest are counted but not sent to the view (like a grid you'd never scroll anyway). */
export const MAX_ROWS_PER_RESULT = 10_000;

export interface ResultColumn {
  name: string;
  type: string;
}
export interface ResultSet {
  columns: ResultColumn[];
  rows: unknown[][];
  /** Rows the server returned, including any beyond MAX_ROWS_PER_RESULT. */
  totalRows: number;
}
export interface QueryMessage {
  kind: "info" | "error";
  text: string;
  /** 1-based line in the submitted script, for errors. */
  line?: number | undefined;
}
export interface QueryRun {
  ok: true;
  resultSets: ResultSet[];
  messages: QueryMessage[];
  hasErrors: boolean;
  cancelled: boolean;
  elapsedMs: number;
  /** DB_NAME() after the run — a USE in the script moves the window's database, as in SSMS. */
  database: string | null;
  rowsAffected: number;
}

/** In-flight requests by query id, so `cancel` can reach them. */
const running = new Map<string, { request: sql.Request | null; cancelled: boolean }>();

/**
 * Splits a script on SSMS's batch separator: a line that is just `GO`
 * (optionally `GO n` to repeat). Not a T-SQL keyword — the client does it.
 */
export function splitBatches(script: string): Array<{ text: string; startLine: number; repeat: number }> {
  const lines = script.split(/\r?\n/);
  const batches: Array<{ text: string; startLine: number; repeat: number }> = [];
  let current: string[] = [];
  let startLine = 1;
  lines.forEach((line, i) => {
    const go = /^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$/i.exec(line);
    if (go) {
      if (current.join("\n").trim()) batches.push({ text: current.join("\n"), startLine, repeat: Number(go[1] ?? 1) });
      current = [];
      startLine = i + 2;
    } else {
      current.push(line);
    }
  });
  if (current.join("\n").trim()) batches.push({ text: current.join("\n"), startLine, repeat: 1 });
  return batches;
}

export async function executeQuery(opts: {
  connectionId: string;
  windowId: string;
  queryId: string;
  database?: string | undefined;
  sql: string;
  /** Line in the editor where `sql` starts (for executing a selection). */
  lineOffset?: number | undefined;
}): Promise<QueryRun> {
  const started = Date.now();
  const state = { request: null as sql.Request | null, cancelled: false };
  running.set(opts.queryId, state);

  const resultSets: ResultSet[] = [];
  const messages: QueryMessage[] = [];
  let hasErrors = false;
  let rowsAffected = 0;
  const lineOffset = (opts.lineOffset ?? 1) - 1;

  try {
    const pool = await windowPool(opts.connectionId, opts.windowId);

    if (opts.database) {
      try {
        await pool.request().batch(`USE ${quoteIdent(opts.database)};`);
      } catch (err) {
        messages.push(formatError(err, 0));
        hasErrors = true;
        return finish();
      }
    }

    for (const batch of splitBatches(opts.sql)) {
      for (let i = 0; i < batch.repeat && !state.cancelled; i++) {
        const outcome = await runBatch(pool, batch.text, batch.startLine + lineOffset, state, resultSets, messages);
        rowsAffected += outcome.rowsAffected;
        if (outcome.error) hasErrors = true;
      }
      if (state.cancelled) break;
    }
    if (state.cancelled) messages.push({ kind: "error", text: "Query was cancelled by user." });

    return await finish(pool);
  } catch (err) {
    messages.push(formatError(err, lineOffset));
    hasErrors = true;
    return finish();
  } finally {
    running.delete(opts.queryId);
  }

  async function finish(pool?: sql.ConnectionPool): Promise<QueryRun> {
    let database: string | null = null;
    if (pool?.connected) {
      database = await pool
        .request()
        .query<{ db: string }>("SELECT DB_NAME() AS db")
        .then((r) => r.recordset[0]?.db ?? null)
        .catch(() => null);
    }
    if (!hasErrors && !state.cancelled) {
      messages.push({ kind: "info", text: `\nCompletion time: ${new Date().toISOString()}` });
    }
    return {
      ok: true,
      resultSets,
      messages,
      hasErrors: hasErrors || state.cancelled,
      cancelled: state.cancelled,
      elapsedMs: Date.now() - started,
      database,
      rowsAffected,
    };
  }
}

export function cancelQuery(queryId: string): boolean {
  const state = running.get(queryId);
  if (!state) return false;
  state.cancelled = true;
  state.request?.cancel();
  return true;
}

/** Runs one batch in streaming mode, collecting result sets (capped), PRINT/info messages and row counts. */
function runBatch(
  pool: sql.ConnectionPool,
  text: string,
  startLine: number,
  state: { request: sql.Request | null; cancelled: boolean },
  resultSets: ResultSet[],
  messages: QueryMessage[],
): Promise<{ rowsAffected: number; error: boolean }> {
  return new Promise((resolve) => {
    const request = new sql.Request(pool);
    request.stream = true;
    request.arrayRowMode = true;
    state.request = request;

    let current: ResultSet | null = null;
    let rowsAffected = 0;
    let error = false;

    request.on("recordset", (columns: unknown) => {
      // arrayRowMode: an array of column metadata, in select-list order (duplicates and unnamed columns preserved).
      const cols = (Array.isArray(columns) ? columns : Object.values(columns as object)) as Array<{
        name: string;
        type?: { declaration?: string };
      }>;
      current = {
        columns: cols.map((c) => ({ name: c.name || "(No column name)", type: c.type?.declaration ?? "" })),
        rows: [],
        totalRows: 0,
      };
      resultSets.push(current);
    });
    request.on("row", (row: unknown[]) => {
      if (!current) return;
      current.totalRows++;
      const cols = current.columns;
      if (current.rows.length < MAX_ROWS_PER_RESULT) current.rows.push(row.map((v, i) => serializeValue(v, cols[i]?.type)));
    });
    request.on("rowsaffected", (count: number) => {
      rowsAffected += count;
      messages.push({ kind: "info", text: `(${count} row${count === 1 ? "" : "s"} affected)` });
    });
    request.on("info", (info: { message: string; number?: number }) => {
      // 5701/5703: "Changed database context/language" — noise from our own USE.
      if (info.number === 5701 || info.number === 5703) return;
      messages.push({ kind: "info", text: info.message });
    });
    request.on("error", (err: unknown) => {
      if (state.cancelled) return;
      error = true;
      messages.push(formatError(err, startLine - 1));
    });
    request.on("done", () => {
      state.request = null;
      resolve({ rowsAffected, error });
    });

    // batch(), not query(): query() wraps the text in sp_executesql, which scopes #temp tables, USE and
    // SET options to that one call. SSMS sends raw batches, so session state carries over between runs.
    request.batch(text);
  });
}

/** "Msg 208, Level 16, State 1, Line 3" + message, with the line mapped back to the editor. */
function formatError(err: unknown, lineOffset: number): QueryMessage {
  const info = sqlErrorInfo(err);
  if (info.number === undefined) return { kind: "error", text: info.message };
  const line = info.lineNumber !== undefined && info.lineNumber > 0 ? info.lineNumber + lineOffset : undefined;
  const head = [
    `Msg ${info.number}`,
    `Level ${info.class ?? 16}`,
    `State ${info.state ?? 1}`,
    info.procName ? `Procedure ${info.procName}` : null,
    line !== undefined ? `Line ${line}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return { kind: "error", text: `${head}\n${info.message}`, line };
}

/** Grid-ready cell values, formatted the way SSMS displays them. */
function serializeValue(value: unknown, type = ""): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    // mssql reads temporal values as UTC (useUTC default), so the ISO text is the stored value.
    const iso = value.toISOString().replace("T", " ").replace("Z", "");
    if (type === "date") return iso.slice(0, 10);
    if (type.startsWith("time")) return iso.slice(11);
    if (type === "smalldatetime") return iso.slice(0, 16) + ":00";
    return iso;
  }
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, 32 * 1024).toString("hex").toUpperCase();
    return `0x${hex}${value.length > 32 * 1024 ? "…" : ""}`;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}
