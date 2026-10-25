import type { PageQuery, Statement, TableAccess, TableColumn, TableTarget, WriteSession } from "@oneclient/sql-core";
import sql from "mssql";
import { CUT_MARKER, LOB_LIMIT, LOB_PREVIEW, cutValue } from "@oneclient/sql-core";
import { quoteIdent } from "./config.js";
import { type ColumnRow, formatType, listColumns, qualified } from "./metadata.js";
import { requireSession } from "./sessions.js";

/** SQL Server's side of the table data editor (see @oneclient/sql-core `TableAccess`). */

const NUMBERS = new Set(["tinyint", "smallint", "int", "float", "real"]);
/** Exact numerics come back as text: a JS number would round a large key, and an UPDATE could hit the wrong row. */
const EXACT = new Set(["bigint", "decimal", "numeric", "money", "smallmoney"]);
const DATES = new Set(["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset", "time"]);
const BINARY = new Set(["binary", "varbinary", "image", "timestamp", "rowversion", "geography", "geometry", "hierarchyid", "sql_variant"]);

const kindOf = (c: ColumnRow): TableColumn["kind"] => {
  const t = c.type.toLowerCase();
  if (NUMBERS.has(t) || EXACT.has(t)) return "number";
  if (t === "bit") return "bool";
  if (DATES.has(t)) return "date";
  if (BINARY.has(t)) return "binary";
  return "text";
};

/** Unbounded text can hold megabytes: those columns are fetched through the cut-off expression below. */
const isLob = (c: ColumnRow) => ["text", "ntext", "xml"].includes(c.type.toLowerCase()) || (["varchar", "nvarchar"].includes(c.type.toLowerCase()) && c.max_length === -1);

function toColumn(c: ColumnRow): TableColumn {
  const kind = kindOf(c);
  const rowversion = ["timestamp", "rowversion"].includes(c.type.toLowerCase());
  return {
    name: c.name,
    type: formatType(c),
    kind,
    nullable: c.is_nullable,
    isPk: c.is_pk,
    hasDefault: c.is_identity || c.is_computed || rowversion || c.default_definition !== null,
    insertable: !c.is_computed && !rowversion && !c.is_identity && kind !== "binary",
    editable: !c.is_computed && !rowversion && !c.is_identity && kind !== "binary" && !["xml", "text", "ntext", "image"].includes(c.type.toLowerCase()),
    ...(isLob(c) ? { lob: true } : {}),
  };
}

/** How one column appears in the page's SELECT: dates as ISO text, exact numbers as text, big values cut, binary summarised. */
function selectExpr(c: TableColumn, raw: string): string {
  const name = quoteIdent(c.name);
  const t = raw.toLowerCase();
  if (c.kind === "binary") return t === "timestamp" || t === "rowversion" ? `CONVERT(varchar(18), ${name}, 1) AS ${name}` : `'(' + CAST(DATALENGTH(${name}) AS varchar(20)) + ' bytes)' AS ${name}`;
  if (c.kind === "date") return `${t === "time" ? `CONVERT(varchar(20), ${name})` : t === "datetimeoffset" ? `CONVERT(varchar(40), ${name}, 127)` : `CONVERT(varchar(40), ${name}, 126)`} AS ${name}`;
  if (EXACT.has(t)) return `CAST(${name} AS varchar(50)) AS ${name}`;
  if (c.lob) {
    const text = `CAST(${name} AS nvarchar(max))`;
    return `CASE WHEN DATALENGTH(${name}) > ${LOB_LIMIT} THEN NCHAR(1) + NCHAR(2) + N'${CUT_MARKER.slice(2)}' + CAST(DATALENGTH(${name}) AS nvarchar(20)) + N':' + LEFT(${text}, ${LOB_PREVIEW}) ELSE ${text} END AS ${name}`;
  }
  return name;
}

/** Real column types, by name (describe() keeps the display type; fetchPage needs the raw one). */
const rawTypes = new Map<string, Map<string, string>>();
const keyOf = (cid: string, t: TableTarget) => `${cid}|${t.database}|${t.schema}|${t.table}`;

export const mssqlTableAccess: TableAccess = {
  quote: quoteIdent,
  qualify: (t) => qualified(t.database, t.schema, t.table),
  literals: { string: "N", bool: { true: "1", false: "0" } },

  async describe(connectionId, target) {
    const rows = await listColumns(requireSession(connectionId).pool, target.database, target.schema, target.table);
    rawTypes.set(keyOf(connectionId, target), new Map(rows.map((r) => [r.name, r.type])));
    if (rawTypes.size > 50) rawTypes.delete(rawTypes.keys().next().value!);
    return rows.map(toColumn);
  },

  async fetchPage(connectionId, target, columns, q: PageQuery) {
    const types = rawTypes.get(keyOf(connectionId, target));
    const list = columns.map((c) => selectExpr(c, types?.get(c.name) ?? c.type)).join(", ");
    // ORDER BY [t].[col], not [col]: the select list aliases some columns to text (exact numbers, dates), and a bare name would sort by that.
    const order = q.orderBy.length ? q.orderBy.map((o) => `[t].${quoteIdent(o.column)}${o.desc ? " DESC" : ""}`).join(", ") : "(SELECT NULL)";
    const text = `SELECT ${list} FROM ${qualified(target.database, target.schema, target.table)} AS [t]${q.where ? ` WHERE ${q.where}` : ""} ORDER BY ${order} OFFSET ${q.offset} ROWS FETCH NEXT ${q.limit} ROWS ONLY`;
    const request = requireSession(connectionId).pool.request();
    request.arrayRowMode = true;
    const r = await request.query<unknown[]>(text);
    return (r.recordset as unknown as unknown[][]).map((row) => row.map(cutValue));
  },

  async estimateRows(connectionId, target) {
    const r = await requireSession(connectionId)
      .pool.request()
      .input("object", qualified(target.database, target.schema, target.table))
      .query<{ n: number | null }>(`SELECT SUM(p.rows) AS n FROM ${quoteIdent(target.database)}.sys.partitions p WHERE p.object_id = OBJECT_ID(@object) AND p.index_id IN (0, 1)`);
    return r.recordset[0]?.n ?? null;
  },

  /** One batch, one transaction: XACT_ABORT rolls everything back when a statement fails or THROWs on an unexpected row count. */
  async apply(connectionId, _target, statements: Statement[]) {
    const body = statements
      .map((s, i) => `${s.sql};\nIF @@ROWCOUNT <> ${s.expect} THROW 51000, N'Statement ${i + 1} should have changed ${s.expect} row(s) but changed another number — someone else may have changed or deleted the data. Nothing was saved.', 1;`)
      .join("\n");
    await requireSession(connectionId).pool.request().batch(`SET XACT_ABORT ON;\nBEGIN TRAN;\n${body}\nCOMMIT TRAN;`);
  },

  /** A transaction on its own connection, for CSV imports: batches run inside it; a failed statement or row count aborts it. */
  async begin(connectionId, target): Promise<WriteSession> {
    const pool = requireSession(connectionId).pool;
    const tx = new sql.Transaction(pool);
    await tx.begin();
    const table = qualified(target.database, target.schema, target.table);
    return {
      async run(statements: Statement[]) {
        const body = statements.map((s, i) => `${s.sql};\nIF @@ROWCOUNT <> ${s.expect} THROW 51000, N'Statement ${i + 1} of the batch inserted another number of rows than expected.', 1;`).join("\n");
        await new sql.Request(tx).batch(`SET XACT_ABORT ON;\n${body}`);
      },

      /**
       * Bulk loads send each batch as ONE JSON parameter read by OPENJSON, so the statement text never changes and its
       * plan is compiled once. (Multi-row INSERT … VALUES with literals compiled a new 7,000-constant statement per batch:
       * about 3,500 rows/s against many times that here.)
       */
      fast: {
        async supports(columns) {
          if (columns.some((c) => c.kind === "binary" || NO_JSON_COLUMN.test(c.type))) return false;
          let ok = openJsonDatabases.get(target.database);
          if (ok === undefined) {
            const r = await pool.request().input("db", target.database).query<{ level: number }>("SELECT compatibility_level AS level FROM sys.databases WHERE name = @db");
            ok = (r.recordset[0]?.level ?? 0) >= 130; // OPENJSON needs SQL Server 2016 compatibility
            openJsonDatabases.set(target.database, ok);
          }
          return ok;
        },
        async insert(columns, rows) {
          const names = columns.map((c) => quoteIdent(c.name)).join(", ");
          const shape = columns.map((c, i) => `${quoteIdent(c.name)} ${c.type} '$[${i}]'`).join(", ");
          const request = new sql.Request(tx);
          request.input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows));
          const r = await request.query(`SET XACT_ABORT ON; INSERT INTO ${table} (${names}) SELECT ${names} FROM OPENJSON(@rows) WITH (${shape})`);
          const inserted = r.rowsAffected.reduce((a, b) => a + b, 0);
          if (inserted !== rows.length) throw new Error(`Inserted ${inserted} row(s) instead of ${rows.length}.`);
        },
      },
      commit: () => tx.commit(),
      rollback: () => tx.rollback(),
    };
  },
};

/** Column types OPENJSON … WITH can't produce. */
const NO_JSON_COLUMN = /^(xml|text|ntext|image|sql_variant|geography|geometry|hierarchyid|timestamp|rowversion)\b/i;
/** Whether a database's compatibility level (130+) allows OPENJSON, checked once per database. */
const openJsonDatabases = new Map<string, boolean>();
