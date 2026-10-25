import type { PageQuery, Statement, TableAccess, TableColumn, TableTarget, WriteSession } from "@oneclient/sql-core";
import { CUT_MARKER, EditError, LOB_LIMIT, LOB_PREVIEW, cutValue } from "@oneclient/sql-core";
import { qualified, quoteIdent } from "./config.js";
import { type ColumnRow, listColumns } from "./metadata.js";
import { poolFor } from "./sessions.js";

/** PostgreSQL's side of the table data editor (see @oneclient/sql-core `TableAccess`). */

const NUMBER = /^(smallint|integer|bigint|int[248]?|numeric|decimal|real|double precision|float[48]?|serial|bigserial|smallserial|money|oid)\b/;
const DATE = /^(date|time|timestamp|interval)\b/;
const LOB = /^(text|json|jsonb|xml)$|^(character varying|varchar)$/;

function kindOf(type: string): TableColumn["kind"] {
  if (type === "boolean") return "bool";
  if (type === "json" || type === "jsonb") return "json";
  if (type === "bytea") return "binary";
  if (NUMBER.test(type)) return "number";
  if (DATE.test(type)) return "date";
  return "text";
}

function toColumn(c: ColumnRow): TableColumn {
  const kind = kindOf(c.type);
  const always = c.identity === "a" || c.generated;
  return {
    name: c.name,
    type: c.type,
    kind,
    nullable: c.nullable,
    isPk: c.isPk,
    hasDefault: c.default !== null || c.identity !== "" || c.generated,
    insertable: !always && kind !== "binary",
    editable: !always && kind !== "binary",
    ...(LOB.test(c.type) ? { lob: true } : {}),
  };
}

/**
 * How one column appears in the page's SELECT: bytea summarised, big text / JSON cut, and `numeric` / `int8` left to the
 * driver's text parsing (so they stay exact). Everything else is selected as is.
 */
function selectExpr(c: TableColumn): string {
  const name = quoteIdent(c.name);
  if (c.kind === "binary") return `CASE WHEN ${name} IS NULL THEN NULL ELSE '(' || octet_length(${name}) || ' bytes)' END AS ${name}`;
  if (c.lob) {
    const text = `${name}::text`;
    return `CASE WHEN octet_length(${text}) > ${LOB_LIMIT} THEN chr(1) || chr(2) || '${CUT_MARKER.slice(2)}' || octet_length(${text}) || ':' || left(${text}, ${LOB_PREVIEW}) ELSE ${text} END AS ${name}`;
  }
  return name;
}

/**
 * A text[] column as a JS array. The pool can be set to return arrays as their text form ("{a,b}"), so both are accepted;
 * quoted elements ("a b", "a\\"b") are unescaped.
 */
export function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  const inner = value.trim().replace(/^\{/, "").replace(/\}$/, "");
  if (!inner) return [];
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quoted) {
      if (ch === "\\") cur += inner[++i] ?? "";
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (out.push(cur), (cur = ""));
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export const postgresTableAccess: TableAccess = {
  quote: quoteIdent,
  qualify: (t) => qualified(t.schema, t.table),
  literals: { string: "", bool: { true: "true", false: "false" } },

  /** pg_constraint: every foreign key of user tables, with its columns in constraint order. */
  async foreignKeys(connectionId, database) {
    const r = await poolFor(connectionId, database).query<{ name: string; schema: string; table: string; ref_schema: string; ref_table: string; columns: unknown; ref_columns: unknown }>(
      `SELECT c.conname::text AS name, ns.nspname::text AS schema, cl.relname::text AS "table", rns.nspname::text AS ref_schema, rcl.relname::text AS ref_table,
              ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
              ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS ref_columns
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         JOIN pg_class rcl ON rcl.oid = c.confrelid JOIN pg_namespace rns ON rns.oid = rcl.relnamespace
        WHERE c.contype = 'f' AND ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname NOT LIKE 'pg_toast%'
        ORDER BY ns.nspname, cl.relname, c.conname`,
    );
    return r.rows.map((x) => ({ name: x.name, table: { schema: x.schema, table: x.table }, columns: textArray(x.columns), refTable: { schema: x.ref_schema, table: x.ref_table }, refColumns: textArray(x.ref_columns) }));
  },

  async describe(connectionId, target) {
    return (await listColumns(poolFor(connectionId, target.database), target.schema, target.table)).map(toColumn);
  },

  async fetchPage(connectionId, target, columns, q: PageQuery) {
    const list = columns.map(selectExpr).join(", ");
    // ORDER BY t."col", not "col": a bare name prefers the select list's output column, which may be a text rendering.
    const order = q.orderBy.length ? ` ORDER BY ${q.orderBy.map((o) => `t.${quoteIdent(o.column)}${o.desc ? " DESC" : ""}`).join(", ")}` : "";
    const text = `SELECT ${list} FROM ${qualified(target.schema, target.table)} AS t${q.where ? ` WHERE ${q.where}` : ""}${order} LIMIT ${q.limit} OFFSET ${q.offset}`;
    const r = await poolFor(connectionId, target.database).query({ text, rowMode: "array" });
    return (r.rows as unknown[][]).map((row) => row.map(cutValue));
  },

  /** pg_class.reltuples: the planner's estimate (-1 until the table has been analyzed). */
  async estimateRows(connectionId, target) {
    const r = await poolFor(connectionId, target.database).query<{ n: string }>(`SELECT reltuples::bigint AS n FROM pg_class WHERE oid = $1::regclass`, [qualified(target.schema, target.table)]);
    const n = Number(r.rows[0]?.n);
    return Number.isFinite(n) && n >= 0 ? n : null;
  },

  /**
   * One round trip for all statements (the simple query protocol runs them in order, each with its own row count),
   * inside BEGIN … so the counts can be checked before COMMIT; any mismatch or error rolls everything back.
   */
  async apply(connectionId, target, statements: Statement[]) {
    const client = await poolFor(connectionId, target.database).connect();
    let broken = false;
    try {
      const results = await client.query(`BEGIN;\n${statements.map((s) => `${s.sql};`).join("\n")}`);
      const list = Array.isArray(results) ? results : [results];
      const bad = statements.findIndex((s, i) => list[i + 1]?.rowCount !== s.expect);
      if (bad >= 0) {
        await client.query("ROLLBACK");
        throw new EditError(`Statement ${bad + 1} should have changed ${statements[bad]!.expect} row(s) but changed ${list[bad + 1]?.rowCount ?? 0} — someone else may have changed or deleted the data. Nothing was saved.`);
      }
      await client.query("COMMIT");
    } catch (err) {
      if (!(err instanceof EditError)) await client.query("ROLLBACK").catch(() => (broken = true));
      throw err;
    } finally {
      client.release(broken);
    }
  },

  /** A transaction on its own pooled connection, for CSV imports: statements run in order, the first failure aborts it. */
  async begin(connectionId, target): Promise<WriteSession> {
    const client = await poolFor(connectionId, target.database).connect();
    try {
      await client.query("BEGIN");
    } catch (err) {
      client.release(true);
      throw err;
    }
    let released = false;
    const release = (broken: boolean) => {
      if (!released) client.release(broken || undefined);
      released = true;
    };
    return {
      async run(statements) {
        const results = await client.query(statements.map((s) => `${s.sql};`).join("\n"));
        const list = Array.isArray(results) ? results : [results];
        const bad = statements.findIndex((s, i) => list[i]?.rowCount !== s.expect);
        if (bad >= 0) throw new EditError(`A statement inserted ${list[bad]?.rowCount ?? 0} row(s) instead of ${statements[bad]!.expect}.`);
      },
      async commit() {
        try {
          await client.query("COMMIT");
          release(false);
        } catch (err) {
          release(true);
          throw err;
        }
      },
      async rollback() {
        try {
          await client.query("ROLLBACK");
          release(false);
        } catch {
          release(true);
        }
      },
    };
  },
};
