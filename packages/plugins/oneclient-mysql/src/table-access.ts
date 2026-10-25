import type { PageQuery, Statement, TableAccess, TableColumn, TableTarget, WriteSession } from "@oneclient/sql-core";
import { CUT_MARKER, EditError, LOB_LIMIT, LOB_PREVIEW, cutValue } from "@oneclient/sql-core";
import type mysql from "mysql2/promise";
import { qualified, quoteIdent } from "./config.js";
import { batchPoolFor, poolFor } from "./sessions.js";

/** MySQL's side of the table data editor (see @oneclient/sql-core `TableAccess`). A MySQL database is the "schema". */

interface ColumnInfo {
  name: string;
  dtype: string;
  type: string;
  nullable: number;
  key: string;
  extra: string;
  dflt: string | null;
}

const NUMBER = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric", "float", "double", "real", "year", "bit"]);
const DATE = new Set(["date", "time", "datetime", "timestamp"]);
const BINARY = new Set(["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob", "geometry", "point", "linestring", "polygon", "multipoint", "multilinestring", "multipolygon", "geometrycollection"]);
/** Types that can hold megabytes: fetched through the cut-off expression below. */
const LOB = new Set(["text", "mediumtext", "longtext", "json"]);

function toColumn(c: ColumnInfo): TableColumn {
  const t = c.dtype.toLowerCase();
  const kind: TableColumn["kind"] = t === "tinyint" && /^tinyint\(1\)/i.test(c.type) ? "bool" : NUMBER.has(t) ? "number" : DATE.has(t) ? "date" : t === "json" ? "json" : BINARY.has(t) ? "binary" : "text";
  const generated = /\b(VIRTUAL|STORED) GENERATED\b/i.test(c.extra);
  return {
    name: c.name,
    type: c.type,
    kind,
    nullable: !!c.nullable,
    isPk: c.key === "PRI",
    hasDefault: c.dflt !== null || /auto_increment|DEFAULT_GENERATED|GENERATED/i.test(c.extra),
    insertable: !generated && kind !== "binary" && t !== "bit",
    editable: !generated && kind !== "binary" && t !== "bit",
    ...(LOB.has(t) ? { lob: true } : {}),
  };
}

/** How one column appears in the page's SELECT: binary summarised, big text / JSON cut. */
function selectExpr(c: TableColumn): string {
  const name = `t.${quoteIdent(c.name)}`;
  const alias = quoteIdent(c.name);
  if (c.kind === "binary") return `CASE WHEN ${name} IS NULL THEN NULL ELSE CONCAT('(', LENGTH(${name}), ' bytes)') END AS ${alias}`;
  if (c.lob) {
    const text = c.kind === "json" ? `CAST(${name} AS CHAR)` : name;
    const marker = `CONCAT(CHAR(1 USING utf8mb4), CHAR(2 USING utf8mb4), '${CUT_MARKER.slice(2)}')`;
    return `CASE WHEN LENGTH(${text}) > ${LOB_LIMIT} THEN CONCAT(${marker}, LENGTH(${text}), ':', LEFT(${text}, ${LOB_PREVIEW})) ELSE ${text} END AS ${alias}`;
  }
  return `${name} AS ${alias}`;
}

/** Statement results from a multi-statement query: one header per statement (a single statement gives the header itself). */
function counts(result: unknown): Array<number | undefined> {
  const list = Array.isArray(result) ? result : [result];
  return list.map((r) => (r as { affectedRows?: number } | undefined)?.affectedRows);
}

function check(statements: Statement[], result: unknown): void {
  const got = counts(result);
  const bad = statements.findIndex((s, i) => got[i] !== s.expect);
  if (bad >= 0) throw new EditError(`Statement ${bad + 1} should have changed ${statements[bad]!.expect} row(s) but changed ${got[bad] ?? 0} — someone else may have changed or deleted the data. Nothing was saved.`);
}

const script = (statements: Statement[]) => statements.map((s) => s.sql).join(";\n");

export const mysqlTableAccess: TableAccess = {
  quote: quoteIdent,
  qualify: (t) => qualified(t.database, t.table),
  // MySQL reads \ inside a string as an escape character, so it is doubled as well as the quote.
  literals: { string: "", bool: { true: "TRUE", false: "FALSE" }, escape: (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "''") },

  async describe(connectionId, target) {
    const [rows] = (await poolFor(connectionId).query(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS dtype, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_KEY AS \`key\`, EXTRA AS extra, COLUMN_DEFAULT AS dflt
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [target.database, target.table],
    )) as unknown as [ColumnInfo[]];
    return rows.map(toColumn);
  },

  async fetchPage(connectionId, target, columns, q: PageQuery) {
    const list = columns.map(selectExpr).join(", ");
    // ORDER BY t.`col`, not `col`: the select list aliases some columns to text, and a bare name would sort by that.
    const order = q.orderBy.length ? ` ORDER BY ${q.orderBy.map((o) => `t.${quoteIdent(o.column)}${o.desc ? " DESC" : ""}`).join(", ")}` : "";
    const sql = `SELECT ${list} FROM ${qualified(target.database, target.table)} AS t${q.where ? ` WHERE ${q.where}` : ""}${order} LIMIT ${q.limit} OFFSET ${q.offset}`;
    const [rows] = (await poolFor(connectionId).query({ sql, rowsAsArray: true })) as unknown as [unknown[][]];
    return rows.map((row) => row.map(cutValue));
  },

  /** information_schema.TABLES.TABLE_ROWS: InnoDB's estimate (exact for MyISAM). */
  async estimateRows(connectionId, target) {
    const [rows] = (await poolFor(connectionId).query("SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [target.database, target.table])) as unknown as [Array<{ n: string | number | null }>];
    const n = Number(rows[0]?.n);
    return Number.isFinite(n) && rows[0]?.n !== null ? n : null;
  },

  /** One round trip for all statements, in one transaction; any error or unexpected row count rolls everything back. */
  async apply(connectionId, _target, statements: Statement[]) {
    const conn = await batchPoolFor(connectionId).getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(script(statements));
      check(statements, result);
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  },

  /** A transaction on its own pooled connection, for CSV imports. */
  async begin(connectionId): Promise<WriteSession> {
    const conn: mysql.PoolConnection = await batchPoolFor(connectionId).getConnection();
    let released = false;
    const release = (destroy: boolean) => {
      if (released) return;
      released = true;
      if (destroy) conn.destroy();
      else conn.release();
    };
    try {
      await conn.beginTransaction();
    } catch (err) {
      release(true);
      throw err;
    }
    return {
      async run(statements) {
        const [result] = await conn.query(script(statements));
        check(statements, result);
      },
      async commit() {
        try {
          await conn.commit();
          release(false);
        } catch (err) {
          release(true);
          throw err;
        }
      },
      async rollback() {
        try {
          await conn.rollback();
          release(false);
        } catch {
          release(true);
        }
      },
    };
  },
};

export type { TableTarget };
