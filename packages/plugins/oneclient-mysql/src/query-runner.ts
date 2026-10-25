import { mysqlErrorInfo } from "./errors.js";
import { quoteIdent } from "./config.js";
import { poolFor, windowSession } from "./sessions.js";
import { splitStatements } from "./split.js";

export { splitStatements };

/** Rows kept per result set; the rest are counted but not kept (and never held in memory). */
export const MAX_ROWS_PER_RESULT = 10_000;

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
  /** 1-based line in the editor, for errors. */
  line?: number | undefined;
}
export interface QueryRun {
  ok: true;
  resultSets: ResultSet[];
  messages: QueryMessage[];
  hasErrors: boolean;
  cancelled: boolean;
  elapsedMs: number;
  /** The window's current database (changes with USE). */
  database: string | null;
  rowsAffected: number;
}

/** In-flight queries by id → server thread, so `cancel` can reach them. */
const running = new Map<string, { connectionId: string; threadId: number; cancelled: boolean }>();

interface Field {
  name: string;
  columnType?: number;
  type?: number;
  flags?: number;
  characterSet?: number;
}
interface OkPacket {
  affectedRows?: number;
  insertId?: number;
  info?: string;
  warningStatus?: number;
}

/** Wire type codes (mysql2 `Types`) → the names SQL uses. */
const TYPE_NAMES: Record<number, string> = {
  0: "decimal", 1: "tinyint", 2: "smallint", 3: "int", 4: "float", 5: "double", 6: "null", 7: "timestamp", 8: "bigint", 9: "mediumint",
  10: "date", 11: "time", 12: "datetime", 13: "year", 15: "varchar", 16: "bit", 245: "json", 246: "decimal", 247: "enum", 248: "set",
  249: "tinyblob", 250: "mediumblob", 251: "longblob", 252: "blob", 253: "varchar", 254: "char", 255: "geometry",
};
const UNSIGNED = 32;
const BINARY_CHARSET = 63;

export function typeName(f: Field): string {
  const code = f.columnType ?? f.type ?? -1;
  let name = TYPE_NAMES[code] ?? "";
  const binary = f.characterSet === BINARY_CHARSET;
  if (binary && (code === 253 || code === 15)) name = "varbinary";
  else if (binary && code === 254) name = "binary";
  else if (!binary && (code === 252 || code === 249 || code === 250 || code === 251)) name = name.replace("blob", "text");
  const unsigned = ((f.flags ?? 0) & UNSIGNED) !== 0;
  return unsigned && /int|decimal|float|double/.test(name) ? `${name} unsigned` : name;
}

/**
 * Runs a script in the window's own session, one statement at a time like the `mysql` client: results before an error
 * are kept and the error line is exact. Rows are streamed and only the first MAX_ROWS_PER_RESULT are kept, so a
 * `SELECT *` on a huge table can't exhaust memory.
 */
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
  const resultSets: ResultSet[] = [];
  const messages: QueryMessage[] = [];
  let hasErrors = false;
  let rowsAffected = 0;
  let database: string | null = null;
  /** The last statement left warnings behind (they belong to this window's session). */
  let warn = false;
  const state = { connectionId: opts.connectionId, threadId: 0, cancelled: false };
  running.set(opts.queryId, state);

  try {
    const w = await windowSession(opts.connectionId, opts.windowId);
    state.threadId = w.threadId;
    if (opts.database && opts.database !== w.database) {
      try {
        await w.connection.query(`USE ${quoteIdent(opts.database)}`);
        w.database = opts.database;
      } catch (err) {
        messages.push(formatError(err, "", 1));
        hasErrors = true;
        return await finish();
      }
    }
    if (!opts.sql.trim()) return await finish();

    for (const stmt of splitStatements(opts.sql)) {
      if (state.cancelled) break;
      try {
        // The promise wrapper hides its callback connection, which is what streams rows without buffering them.
        await runStatement(w.connection as unknown as { connection: { query(o: unknown): Query } }, stmt.text);
        if (warn) await reportWarnings(w.connection);
        // A script may change the database with USE; keep the window's idea of it current.
        if (/^\s*USE\b/i.test(stmt.text)) w.database = stmt.text.replace(/^\s*USE\s+/i, "").replace(/[`;]/g, "").trim() || w.database;
      } catch (err) {
        hasErrors = true;
        if (state.cancelled) break;
        messages.push(formatError(err, stmt.text, stmt.startLine + (opts.lineOffset ?? 1) - 1));
        break;
      }
    }
    if (state.cancelled) messages.push({ kind: "error", text: "Query was cancelled by user." });
    return await finish(w);
  } catch (err) {
    messages.push(formatError(err, "", 1));
    hasErrors = true;
    return await finish();
  } finally {
    running.delete(opts.queryId);
  }

  /** One statement, streamed: each `fields` event starts a result set, rows fill it, an OK packet becomes a message. */
  function runStatement(connection: { connection: { query(o: unknown): Query } }, text: string): Promise<void> {
    warn = false;
    return new Promise((resolve, reject) => {
      let current: { columns: ResultColumn[]; rows: unknown[][]; total: number } | null = null;
      const close = () => {
        if (!current) return;
        resultSets.push({ columns: current.columns, rows: current.rows, totalRows: current.total });
        messages.push({ kind: "info", text: `(${current.total.toLocaleString()} row${current.total === 1 ? "" : "s"})` });
        current = null;
      };
      const q = connection.connection.query({ sql: text, rowsAsArray: true });
      q.on("fields", (fields: Field[]) => {
        close();
        current = { columns: fields.map((f) => ({ name: f.name, type: typeName(f) })), rows: [], total: 0 };
      });
      q.on("result", (r: unknown) => {
        if (Array.isArray(r)) {
          if (!current) return;
          current.total++;
          if (current.rows.length < MAX_ROWS_PER_RESULT) current.rows.push(r.map(serializeValue));
        } else {
          const ok = r as OkPacket;
          rowsAffected += ok.affectedRows ?? 0;
          messages.push({ kind: "info", text: `${(ok.affectedRows ?? 0).toLocaleString()} row${ok.affectedRows === 1 ? "" : "s"} affected${ok.info ? ` — ${ok.info.trim()}` : ""}${ok.insertId ? ` (last insert id ${ok.insertId})` : ""}` });
          if ((ok.warningStatus ?? 0) > 0) warn = true;
        }
      });
      q.on("error", (err: Error) => {
        close();
        reject(err);
      });
      q.on("end", () => {
        close();
        resolve();
      });
    });
  }

  async function reportWarnings(connection: { query(sql: string): Promise<unknown> }) {
    warn = false;
    try {
      const [rows] = (await connection.query("SHOW WARNINGS")) as [Array<{ Level: string; Code: number; Message: string }>];
      for (const r of rows) messages.push({ kind: "info", text: `${r.Level} ${r.Code}: ${r.Message}` });
    } catch {
      /* warnings are a courtesy */
    }
  }

  async function finish(w?: { connection: { query(sql: string): Promise<unknown> }; database: string | null }): Promise<QueryRun> {
    if (w && !state.cancelled) {
      try {
        const [rows] = (await w.connection.query("SELECT DATABASE() AS db")) as [Array<{ db: string | null }>];
        w.database = rows[0]?.db ?? w.database;
      } catch {
        /* keep what we had */
      }
    }
    database = w?.database ?? null;
    if (!hasErrors && !state.cancelled && opts.sql.trim()) messages.push({ kind: "info", text: `\nCompletion time: ${new Date().toISOString()}` });
    return { ok: true, resultSets, messages, hasErrors: hasErrors || state.cancelled, cancelled: state.cancelled, elapsedMs: Date.now() - started, database, rowsAffected };
  }
}

interface Query {
  on(event: string, fn: (...args: any[]) => void): Query;
}

/** KILL QUERY from a second connection: stops the statement, keeps the session. */
export async function cancelQuery(queryId: string): Promise<boolean> {
  const state = running.get(queryId);
  if (!state?.threadId) return false;
  state.cancelled = true;
  await poolFor(state.connectionId)
    .query(`KILL QUERY ${Number(state.threadId)}`)
    .catch(() => undefined);
  return true;
}

/** "ERROR 1064 (42000): You have an error…" with the line mapped to the editor ("… near 'x' at line 2"). */
export function formatError(err: unknown, sql: string, lineOffset: number): QueryMessage {
  const info = mysqlErrorInfo(err);
  const at = /\bat line (\d+)/.exec(info.message);
  const line = at && sql ? Number(at[1]) + lineOffset - 1 : sql ? lineOffset : undefined;
  const head = info.errno ? `ERROR ${info.errno}${info.sqlState ? ` (${info.sqlState})` : ""}: ` : "ERROR: ";
  return { kind: "error", text: `${head}${info.message}${line !== undefined ? `\nLine ${line}` : ""}`, line };
}

/** Grid-ready cell values. */
export function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.length <= 16 ? `0x${value.toString("hex")}` : `(${value.length.toLocaleString()} bytes)`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" && value.length > 64 * 1024) return `${value.slice(0, 64 * 1024)}…`;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}
