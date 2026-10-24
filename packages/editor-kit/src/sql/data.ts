/**
 * Pure helpers for SQL result sets: ordering, filtering, and turning rows into CSV / TSV / JSON / Markdown / INSERTs.
 * Shared by every SQL plugin's results grid (see ResultGrid.tsx).
 */

export interface ResultColumn {
  name: string;
  type: string;
}

export interface ResultSet {
  columns: ResultColumn[];
  rows: unknown[][];
  totalRows: number;
}

export type Dialect = "postgres" | "mssql" | "mysql" | "sqlite";

/** How a value reads in the grid and in text exports. */
export const display = (v: unknown): string => (v === null || v === undefined ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v));

const NUMERIC = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/** Sort order for one column: NULLs last, numbers (also numeric strings such as bigint) by value, text naturally. */
export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const sa = display(a);
  const sb = display(b);
  if (NUMERIC.test(sa) && NUMERIC.test(sb)) return Number(sa) - Number(sb);
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Indexes of the rows to show, in order: those containing `filter` (any column, case-insensitive; `col:value` limits it
 * to one column), sorted by `sort`. Sorting is stable, so equal values keep the server's order.
 */
export function viewOrder(result: ResultSet, filter: string, sort: { col: number; desc: boolean } | null): number[] {
  let order = result.rows.map((_, i) => i);
  const f = filter.trim().toLowerCase();
  if (f) {
    const scoped = /^([^:\s]+):(.*)$/.exec(f);
    const col = scoped ? result.columns.findIndex((c) => c.name.toLowerCase() === scoped[1]) : -1;
    const needle = col >= 0 ? scoped![2]!.trim() : f;
    order = order.filter((i) => {
      const row = result.rows[i]!;
      return col >= 0 ? display(row[col]).toLowerCase().includes(needle) : row.some((v) => display(v).toLowerCase().includes(needle));
    });
  }
  if (sort) {
    const dir = sort.desc ? -1 : 1;
    const isNull = (v: unknown) => v === null || v === undefined;
    order.sort((x, y) => {
      const a = result.rows[x]![sort.col];
      const b = result.rows[y]![sort.col];
      // NULLs stay at the bottom in both directions.
      if (isNull(a) || isNull(b)) return Number(isNull(a)) - Number(isNull(b)) || x - y;
      return dir * compareValues(a, b) || x - y;
    });
  }
  return order;
}

export interface Rect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** The cells of a selection (in view order), as a 2-D array plus its column headers. */
export function pick(result: ResultSet, order: number[], rect: Rect): { columns: ResultColumn[]; rows: unknown[][] } {
  const [ra, rb] = rect.r0 <= rect.r1 ? [rect.r0, rect.r1] : [rect.r1, rect.r0];
  const [ca, cb] = rect.c0 <= rect.c1 ? [rect.c0, rect.c1] : [rect.c1, rect.c0];
  const rows: unknown[][] = [];
  for (let r = ra; r <= rb; r++) {
    const row = result.rows[order[r]!];
    if (row) rows.push(row.slice(ca, cb + 1));
  }
  return { columns: result.columns.slice(ca, cb + 1), rows };
}

// ---- formats -----------------------------------------------------------------------------------------------------------

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = display(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** RFC 4180 CSV (NULL = empty field), CRLF line ends — what Excel and every importer expect. */
export function toCsv(columns: ResultColumn[], rows: unknown[][]): string {
  return [columns.map((c) => csvCell(c.name)).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n";
}

/** Tab-separated, NULL spelled out — pastes into spreadsheets cell by cell. */
export function toTsv(columns: ResultColumn[] | null, rows: unknown[][]): string {
  const clean = (v: unknown) => display(v).replace(/[\t\r\n]+/g, " ");
  return [...(columns ? [columns.map((c) => c.name).join("\t")] : []), ...rows.map((r) => r.map(clean).join("\t"))].join("\r\n");
}

/** An array of objects; JSON-looking text values (json / jsonb columns) stay structured. */
export function toJson(columns: ResultColumn[], rows: unknown[][]): string {
  const value = (v: unknown, type: string) => {
    if (typeof v === "string" && /json/i.test(type)) {
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    return v ?? null;
  };
  return `${JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, value(r[i], c.type)]))),
    null,
    2,
  )}\n`;
}

/** A GitHub-flavoured Markdown table — for issues, PRs and docs. */
export function toMarkdown(columns: ResultColumn[], rows: unknown[][]): string {
  const cell = (v: unknown) => display(v).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  return [`| ${columns.map((c) => cell(c.name)).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n") + "\n";
}

export function quoteIdent(name: string, dialect: Dialect): string {
  if (dialect === "mssql") return `[${name.replace(/]/g, "]]")}]`;
  if (dialect === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlLiteral(v: unknown, dialect: Dialect): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return dialect === "mssql" ? (v ? "1" : "0") : v ? "TRUE" : "FALSE";
  const s = display(v).replace(/'/g, "''");
  // SQL Server: N'…' keeps non-ASCII text intact in (n)varchar columns.
  return dialect === "mssql" && /[^\x00-\x7f]/.test(s) ? `N'${s}'` : `'${s}'`;
}

/** INSERT statements for the rows, batched (1,000 rows per statement — SQL Server's VALUES limit). */
export function toInserts(columns: ResultColumn[], rows: unknown[][], table: string, dialect: Dialect): string {
  if (!rows.length) return "";
  const target = table.split(".").map((p) => quoteIdent(p, dialect)).join(".");
  const cols = columns.map((c) => quoteIdent(c.name, dialect)).join(", ");
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    out.push(`INSERT INTO ${target} (${cols}) VALUES\n${chunk.map((r) => `    (${r.map((v) => sqlLiteral(v, dialect)).join(", ")})`).join(",\n")};`);
  }
  return `${out.join("\n\n")}\n`;
}

/** A cell's value for the viewer: pretty JSON when it is JSON, else the text itself. */
export function prettyValue(v: unknown): { text: string; json: boolean } {
  if (v === null || v === undefined) return { text: "NULL", json: false };
  if (typeof v === "object") return { text: JSON.stringify(v, null, 2), json: true };
  const s = String(v);
  const t = s.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return { text: JSON.stringify(JSON.parse(t), null, 2), json: true };
    } catch {
      // not JSON after all
    }
  }
  return { text: s, json: false };
}

/**
 * For each SELECT in a script (in order), the table after its first FROM — the default target for "Copy as INSERT" of
 * the matching result set. `undefined` where there is none (expressions, joins are fine: the first table wins).
 */
export function guessTables(sql: string): Array<string | undefined> {
  const ident = String.raw`(?:"(?:[^"]|"")+"|\[(?:[^\]]|\]\])+\]|\x60[^\x60]+\x60|[A-Za-z_][\w$#@]*)`;
  const from = new RegExp(String.raw`\bFROM\s+(${ident}(?:\s*\.\s*${ident}){0,2})`, "i");
  const unquote = (p: string) => p.trim().replace(/^"(.*)"$/s, (_, x: string) => x.replace(/""/g, '"')).replace(/^\[(.*)\]$/s, (_, x: string) => x.replace(/]]/g, "]")).replace(/^`(.*)`$/s, "$1");
  return sql
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ")
    .split(/;|^\s*GO\s*$/im)
    .filter((s) => /^\s*(WITH\b[\s\S]*\bSELECT|SELECT|TABLE|VALUES)\b/i.test(s))
    .map((s) => {
      const m = from.exec(s);
      // FROM generate_series(…) / a table-valued function isn't a table to insert into
      if (!m || /^\s*\(/.test(s.slice(m.index + m[0].length))) return undefined;
      const parts = m[1]!.split(new RegExp(String.raw`\s*\.\s*(?=${ident}$|${ident}\s*\.)`)).map(unquote);
      // SQL Server three-part names: drop the database
      return (parts.length > 2 ? parts.slice(-2) : parts).join(".");
    });
}
