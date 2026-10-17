import type pg from "pg";
import { pgErrorInfo } from "./errors.js";
import { poolFor, windowSession } from "./sessions.js";

/** Rows kept per result set; the rest are counted but not sent to the view. */
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
  /** The window's database (fixed per connection in PostgreSQL). */
  database: string | null;
  rowsAffected: number;
}

/** In-flight queries by id → backend pid, so `cancel` can reach them. */
const running = new Map<string, { connectionId: string; database: string; pid: number | undefined; cancelled: boolean }>();

/** Type names per database, filled lazily from pg_type (field metadata only carries OIDs). */
const typeNames = new Map<string, Map<number, string>>();

async function typeName(connectionId: string, database: string, oids: number[]): Promise<Map<number, string>> {
  const key = `${connectionId}|${database}`;
  let names = typeNames.get(key);
  if (!names) typeNames.set(key, (names = new Map()));
  const missing = [...new Set(oids)].filter((o) => !names!.has(o));
  if (missing.length) {
    try {
      const r = await poolFor(connectionId, database).query<{ oid: number; name: string }>(`SELECT oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])`, [missing]);
      for (const row of r.rows) names.set(row.oid, row.name);
    } catch {
      /* the grid just shows no type */
    }
  }
  return names;
}

/**
 * Runs a script in the window's own session. The whole text goes over the simple-query protocol, so it can hold
 * many statements (each SELECT becomes a result set); like psql, the first error stops the rest of the script.
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
  const state = { connectionId: opts.connectionId, database: "", pid: undefined as number | undefined, cancelled: false };
  running.set(opts.queryId, state);

  try {
    const w = await windowSession(opts.connectionId, opts.windowId, opts.database);
    database = w.database;
    state.database = w.database;
    state.pid = (w.client as unknown as { processID?: number }).processID;
    if (!opts.sql.trim()) return finish();

    w.onNotice = (text) => messages.push({ kind: "info", text });
    try {
      // One statement at a time, like psql: results before an error are kept, each statement autocommits
      // (unless the script opens a transaction), and the error line is exact.
      for (const stmt of splitStatements(opts.sql)) {
        if (state.cancelled) break;
        try {
          const res = (await w.client.query({ text: stmt.text, rowMode: "array" } as pg.QueryConfig)) as unknown as pg.QueryArrayResult | pg.QueryArrayResult[];
          for (const r of Array.isArray(res) ? res : [res]) await collect(r);
        } catch (err) {
          hasErrors = true;
          if (state.cancelled) break;
          messages.push(formatError(err, stmt.text, stmt.startLine + (opts.lineOffset ?? 1) - 1));
          // ReadyForQuery arrives right after the error, before query() rejects.
          if (w.txStatus === "E") messages.push({ kind: "info", text: "The transaction is aborted: run ROLLBACK before running more statements." });
          break;
        }
      }
      if (state.cancelled) messages.push({ kind: "error", text: "Query was cancelled by user." });
    } finally {
      w.onNotice = null;
    }
    return finish();
  } catch (err) {
    messages.push(formatError(err, "", 1));
    hasErrors = true;
    return finish();
  } finally {
    running.delete(opts.queryId);
  }

  async function collect(r: pg.QueryArrayResult) {
    const command = (r.command ?? "").toUpperCase();
    if (r.fields && r.fields.length > 0) {
      const names = await typeName(opts.connectionId, state.database, r.fields.map((f) => f.dataTypeID));
      const rows = r.rows ?? [];
      resultSets.push({
        columns: r.fields.map((f) => ({ name: f.name || "?column?", type: names.get(f.dataTypeID) ?? "" })),
        rows: rows.slice(0, MAX_ROWS_PER_RESULT).map((row) => row.map(serializeValue)),
        totalRows: rows.length,
      });
      if (command === "SELECT" || command === "FETCH" || command === "SHOW" || command === "") return messages.push({ kind: "info", text: `(${rows.length} row${rows.length === 1 ? "" : "s"})` });
    }
    if (["INSERT", "UPDATE", "DELETE", "MERGE", "COPY", "MOVE"].includes(command)) {
      rowsAffected += r.rowCount ?? 0;
      messages.push({ kind: "info", text: `${command}${command === "INSERT" ? " 0" : ""} ${r.rowCount ?? 0}` });
    } else if (command && command !== "SELECT") {
      messages.push({ kind: "info", text: command });
    }
  }

  function finish(): QueryRun {
    if (!hasErrors && !state.cancelled && opts.sql.trim()) messages.push({ kind: "info", text: `\nCompletion time: ${new Date().toISOString()}` });
    return { ok: true, resultSets, messages, hasErrors: hasErrors || state.cancelled, cancelled: state.cancelled, elapsedMs: Date.now() - started, database, rowsAffected };
  }
}

/**
 * Splits a script into statements on top-level `;` — not inside 'strings', E'escapes', "identifiers",
 * $tag$ bodies $tag$, -- comments, nested block comments, or a BEGIN ATOMIC … END body. `startLine` is 1-based.
 */
export function splitStatements(script: string): Array<{ text: string; startLine: number }> {
  const out: Array<{ text: string; startLine: number }> = [];
  let start = 0;
  let line = 1;
  let startLine = 1;
  let atomic = 0; // BEGIN ATOMIC nesting (CASE … END inside counts too)
  const push = (end: number) => {
    const text = script.slice(start, end);
    if (text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()) {
      // Drop leading blanks and -- comments (e.g. the rest of the previous statement's line), so startLine is
      // the line of the first real token and error positions count from there.
      const lead = /^(?:\s+|--[^\n]*)*/.exec(text)![0];
      out.push({ text: text.slice(lead.length).trimEnd(), startLine: startLine + (lead.match(/\n/g)?.length ?? 0) });
    }
  };
  let i = 0;
  while (i < script.length) {
    const ch = script[i]!;
    const next = script[i + 1];
    if (ch === "\n") {
      line++;
      i++;
    } else if (ch === "-" && next === "-") {
      while (i < script.length && script[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < script.length && depth > 0) {
        if (script[i] === "\n") line++;
        if (script[i] === "/" && script[i + 1] === "*") (depth++, (i += 2));
        else if (script[i] === "*" && script[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
    } else if (ch === "'" || ch === '"') {
      const escapes = ch === "'" && /[Ee]/.test(script[i - 1] ?? "") && !/\w/.test(script[i - 2] ?? "");
      i++;
      while (i < script.length) {
        const c = script[i]!;
        if (c === "\n") line++;
        if (escapes && c === "\\") i += 2;
        else if (c === ch && script[i + 1] === ch) i += 2;
        else if (c === ch) {
          i++;
          break;
        } else i++;
      }
    } else if (ch === "$" && !/\w/.test(script[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][\w]*)?\$/.exec(script.slice(i))?.[0];
      if (!tag) {
        i++;
        continue;
      }
      const close = script.indexOf(tag, i + tag.length);
      const end = close === -1 ? script.length : close + tag.length;
      line += script.slice(i, end).match(/\n/g)?.length ?? 0;
      i = end;
    } else if (/[A-Za-z_]/.test(ch) && !/[\w$]/.test(script[i - 1] ?? "")) {
      const word = /^[A-Za-z_][\w$]*/.exec(script.slice(i))![0];
      const upper = word.toUpperCase();
      if (upper === "ATOMIC" && /\bBEGIN\s+$/i.test(script.slice(Math.max(0, i - 20), i))) atomic++;
      else if (atomic > 0 && upper === "CASE") atomic++;
      else if (atomic > 0 && upper === "END") atomic--;
      i += word.length;
    } else if (ch === ";" && atomic === 0) {
      push(i + 1);
      start = i + 1;
      startLine = line;
      i++;
    } else i++;
  }
  push(script.length);
  return out;
}

/** Asks the server to cancel the window's running statement (pg_cancel_backend from a second connection). */
export async function cancelQuery(queryId: string): Promise<boolean> {
  const state = running.get(queryId);
  if (!state?.pid) return false;
  state.cancelled = true;
  await poolFor(state.connectionId, state.database)
    .query("SELECT pg_cancel_backend($1)", [state.pid])
    .catch(() => undefined);
  return true;
}

/** psql-style "ERROR:  message" + DETAIL / HINT, with the position mapped to an editor line. */
export function formatError(err: unknown, sql: string, lineOffset: number): QueryMessage {
  const info = pgErrorInfo(err);
  const line = info.position && sql ? sql.slice(0, info.position - 1).split("\n").length + lineOffset - 1 : undefined;
  const parts = [`${info.severity ?? "ERROR"}:  ${info.message}`];
  if (info.detail) parts.push(`DETAIL:  ${info.detail}`);
  if (info.hint) parts.push(`HINT:  ${info.hint}`);
  if (info.where) parts.push(`CONTEXT:  ${info.where}`);
  const tail = [info.code ? `SQL state: ${info.code}` : null, line !== undefined ? `Line ${line}` : null].filter(Boolean).join(", ");
  if (tail) parts.push(tail);
  return { kind: "error", text: parts.join("\n"), line };
}

/** Grid-ready cell values. Most types already arrive as server text (see pgTypes). */
export function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" && value.length > 64 * 1024) return `${value.slice(0, 64 * 1024)}…`;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}
