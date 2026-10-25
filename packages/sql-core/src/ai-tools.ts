import type { CommandHandler } from "@oneclient/plugin-api";
import type { ExecuteQuery } from "./types.js";

/**
 * What the AI assistant may do with a SQL connection (the `oneclient.aiTools` extension point, declared in each
 * SQL plugin's manifest): look at the schema, run read-only queries, and — only after the user approves —
 * run anything else. Everything goes through the same query runner as the query window.
 */

/** Words that make a statement more than a read, wherever they appear outside strings and comments. */
const WRITE_WORDS = new Set(["insert", "update", "delete", "merge", "drop", "alter", "create", "truncate", "grant", "revoke", "exec", "execute", "call", "into", "replace", "upsert", "vacuum", "analyze", "copy", "set", "declare", "use", "lock", "load", "handler", "attach", "pragma"]);
const READ_STARTS = new Set(["select", "with", "show", "describe", "desc", "explain", "values", "table"]);

/** Removes comments and the contents of string / quoted-identifier literals, so keyword checks see only real SQL. */
function strip(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (c === "-" && n === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && c !== "'" ) i++;
        else if (sql[i] === c) {
          if (sql[i + 1] === c) i++;
          else break;
        }
        i++;
      }
      i++;
      out += c === "'" ? "''" : "q";
    } else if (c === "[") {
      const end = sql.indexOf("]", i);
      i = end === -1 ? sql.length : end + 1;
      out += "q";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * True when `sql` is one statement that only reads: SELECT / WITH … SELECT / SHOW / DESCRIBE / EXPLAIN / VALUES.
 * Deliberately strict — anything it is unsure about goes through the approval path instead.
 */
export function isReadOnlySql(sql: string): boolean {
  const s = strip(sql).trim().replace(/;+\s*$/, "");
  if (!s || s.includes(";")) return false;
  const words = s.toLowerCase().match(/[a-z_]+/g) ?? [];
  if (!words.length || !READ_STARTS.has(words[0]!)) return false;
  if (words.some((w) => WRITE_WORDS.has(w))) return false;
  // SELECT … FOR UPDATE / FOR SHARE take locks.
  if (/\bfor\s+(update|share|no\s+key)/i.test(s)) return false;
  return true;
}

interface AiOptions {
  prefix: string;
  executeQuery: ExecuteQuery;
  ensureConnected(connectionId: string): void;
  releaseWindow?: ((connectionId: string, windowId: string) => Promise<void>) | undefined;
  describeError(err: unknown): string;
}

interface ResultSetLike {
  columns?: Array<{ name?: string } | string>;
  rows?: unknown[][];
  totalRows?: number;
}

const SYSTEM_SCHEMAS = "'information_schema','pg_catalog','pg_toast','sys','mysql','performance_schema','guest','db_owner','db_accessadmin','db_securityadmin','db_ddladmin','db_backupoperator','db_datareader','db_datawriter','db_denydatareader','db_denydatawriter'";
const MAX_CELL = 200;
type Outcome = { ok: boolean; text?: string; error?: string; sets?: ResultSetLike[] };
let counter = 0;

const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const flat = s.replace(/[\t\r\n]+/g, " ");
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL)}…` : flat;
};

/** A result set as tab-separated text (cheap in tokens, easy for a model to read). */
function table(rs: ResultSetLike, maxRows: number): string {
  const names = (rs.columns ?? []).map((c) => (typeof c === "string" ? c : (c.name ?? "")));
  const rows = rs.rows ?? [];
  const shown = rows.slice(0, maxRows);
  const lines = [names.join("\t"), ...shown.map((r) => r.map(cell).join("\t"))];
  const total = rs.totalRows ?? rows.length;
  if (total > shown.length) lines.push(`… ${total - shown.length} more rows not shown (${total} total). Add a WHERE / LIMIT or aggregate.`);
  return lines.join("\n");
}

export function createAiCommands(o: AiOptions): CommandHandler[] {
  async function run(connectionId: string, sql: string, database: string | undefined, maxRows: number): Promise<Outcome> {
    o.ensureConnected(connectionId);
    const windowId = `ai-${connectionId}`;
    const queryId = `ai-${Date.now()}-${counter++}`;
    try {
      const r = (await o.executeQuery({ connectionId, windowId, queryId, ...(database ? { database } : {}), sql })) as unknown as {
        resultSets?: ResultSetLike[];
        messages?: Array<{ kind: string; text: string }>;
        hasErrors?: boolean;
        elapsedMs?: number;
        rowsAffected?: number;
      };
      const errors = (r.messages ?? []).filter((m) => m.kind === "error").map((m) => m.text);
      if (r.hasErrors || errors.length) return { ok: false, error: errors.join("\n") || "The query failed." };
      const parts = (r.resultSets ?? []).map((rs, i, all) => `${all.length > 1 ? `-- result ${i + 1}\n` : ""}${table(rs, maxRows)}`);
      const infos = (r.messages ?? []).filter((m) => m.kind === "info" && !/^\(\d+ rows?\)$/.test(m.text) && !/^Completion time/.test(m.text)).map((m) => m.text);
      const tail = [`${r.elapsedMs ?? 0} ms`, r.rowsAffected ? `${r.rowsAffected} rows affected` : "", ...infos].filter(Boolean).join(" · ");
      return { ok: true, text: `${parts.join("\n\n") || "(no result set)"}\n${tail}`, sets: r.resultSets ?? [] };
    } finally {
      await o.releaseWindow?.(connectionId, windowId).catch(() => undefined);
    }
  }

  const cmd = (id: string, fn: (a: Record<string, unknown>) => Promise<Outcome>): CommandHandler => ({
    commandId: `${o.prefix}.ai.${id}`,
    execute: async (args) => {
      try {
        const a = (args[0] ?? {}) as Record<string, unknown>;
        if (typeof a.connectionId !== "string" || !a.connectionId) return { ok: false, error: "connectionId is required (see list_connections)." };
        return await fn(a);
      } catch (err) {
        return { ok: false, error: o.describeError(err) };
      }
    },
  });
  const rowsArg = (a: Record<string, unknown>) => Math.min(200, Math.max(1, Number(a.maxRows) || 50));
  const db = (a: Record<string, unknown>) => (typeof a.database === "string" && a.database.trim() ? a.database.trim() : undefined);
  const sqlArg = (a: Record<string, unknown>) => {
    if (typeof a.sql !== "string" || !a.sql.trim()) throw new Error("sql is required.");
    return a.sql;
  };

  return [
    cmd("schema", async (a) => {
      const filter = typeof a.filter === "string" ? a.filter.trim().replace(/'/g, "''") : "";
      const r = await run(
        a.connectionId as string,
        `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN (${SYSTEM_SCHEMAS})${filter ? ` AND (table_name LIKE '%${filter}%' OR table_schema LIKE '%${filter}%')` : ""} ORDER BY table_schema, table_name, ordinal_position`,
        db(a),
        5000,
      );
      if (!r.ok) return r;
      // Fold into "schema.table(col type, …)" — far smaller than one row per column.
      const byTable = new Map<string, string[]>();
      for (const [schema, name, column, type] of r.sets?.[0]?.rows ?? []) {
        const key = `${String(schema)}.${String(name)}`;
        const cols = byTable.get(key) ?? [];
        cols.push(`${String(column)} ${String(type ?? "")}`.trim());
        byTable.set(key, cols);
      }
      if (!byTable.size) return { ok: true, text: filter ? `No tables match "${filter}".` : "No user tables found (is the right database selected?)." };
      const entries = [...byTable.entries()].slice(0, 300).map(([t, cols]) => `${t}(${cols.join(", ")})`);
      return { ok: true, text: `${entries.join("\n")}${byTable.size > 300 ? `\n… ${byTable.size - 300} more tables; pass a filter.` : ""}` };
    }),

    cmd("query", async (a) => {
      const sql = sqlArg(a);
      if (!isReadOnlySql(sql)) return { ok: false, error: "This tool only runs one read-only statement (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN). For anything that changes data use the matching *_execute tool — the user is asked to approve it." };
      return run(a.connectionId as string, sql, db(a), rowsArg(a));
    }),

    cmd("execute", async (a) => run(a.connectionId as string, sqlArg(a), db(a), rowsArg(a))),
  ];
}
