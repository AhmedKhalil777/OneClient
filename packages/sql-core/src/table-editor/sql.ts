import type { CellInput, Change, Statement, TableAccess, TableColumn, TableTarget } from "./types.js";

/** Rows per multi-row INSERT / per `IN (…)` delete: SQL Server allows 1,000 row values per INSERT. */
export const BATCH_ROWS = 500;

/** A problem with what the user staged; the message is shown as is. */
export class EditError extends Error {}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TRUE = new Set(["true", "t", "1", "yes", "y", "on"]);
const FALSE = new Set(["false", "f", "0", "no", "n", "off"]);

/** A SQL literal for what the user typed into a cell of this column; throws a message naming the column when it doesn't fit. */
export function literal(value: CellInput, col: TableColumn, access: Pick<TableAccess, "literals">): string {
  return toLiteral(normalizeValue(value, col), col, access);
}

/** The literal for an already normalized value (see normalizeValue). */
export function toLiteral(v: string | null, col: TableColumn, access: Pick<TableAccess, "literals">): string {
  if (v === null) return "NULL";
  if (col.kind === "number") return v;
  if (col.kind === "bool") return v === "true" ? access.literals.bool.true : access.literals.bool.false;
  return `${access.literals.string}'${access.literals.escape ? access.literals.escape(v) : v.replace(/'/g, "''")}'`;
}

/**
 * Checks what the user typed (or the CSV held) against the column and returns it normalized: null for NULL, a plain
 * number, "true" / "false" for booleans, the text itself otherwise. Throws a message naming the column when it doesn't fit.
 */
export function normalizeValue(value: CellInput | undefined, col: TableColumn): string | null {
  if (value === null || value === undefined) {
    if (!col.nullable) throw new EditError(`"${col.name}" doesn't accept NULL.`);
    return null;
  }
  const text = typeof value === "string" ? value : String(value);
  if (col.kind === "number") {
    const t = text.trim();
    if (!NUMBER.test(t)) throw new EditError(`"${text}" is not a number (column "${col.name}", ${col.type}).`);
    return t.startsWith("+") ? t.slice(1) : t;
  }
  if (col.kind === "bool") {
    const t = text.trim().toLowerCase();
    if (TRUE.has(t)) return "true";
    if (FALSE.has(t)) return "false";
    throw new EditError(`"${text}" is not true or false (column "${col.name}").`);
  }
  if (col.kind === "json") {
    try {
      JSON.parse(text);
    } catch {
      throw new EditError(`The value of "${col.name}" is not valid JSON.`);
    }
  }
  if (text.includes("\0")) throw new EditError(`"${col.name}": a value can't contain a NUL character.`);
  return text;
}

function whereKey(key: Record<string, CellInput>, pk: TableColumn[], access: TableAccess): string {
  return pk
    .map((c) => {
      const v = key[c.name];
      if (v === null || v === undefined) throw new EditError(`The row has no value for key column "${c.name}".`);
      return `${access.quote(c.name)} = ${literal(v, c, access)}`;
    })
    .join(" AND ");
}

function column(columns: TableColumn[], name: string): TableColumn {
  const c = columns.find((x) => x.name === name);
  if (!c) throw new EditError(`Unknown column "${name}".`);
  return c;
}

/**
 * The statements for the staged changes: updates, then inserts, then deletes. Single-column deletes and same-shape
 * inserts are batched, so thousands of rows become a handful of statements (one round trip, one transaction).
 */
export function buildStatements(target: TableTarget, columns: TableColumn[], changes: Change[], access: TableAccess): Statement[] {
  const pk = columns.filter((c) => c.isPk);
  const table = access.qualify(target);
  const out: Statement[] = [];

  for (const ch of changes) {
    if (ch.kind !== "update") continue;
    if (!pk.length) throw new EditError("The table has no primary key, so rows can't be updated safely.");
    const sets = Object.entries(ch.set).map(([name, v]) => {
      const c = column(columns, name);
      if (!c.editable) throw new EditError(`"${name}" can't be edited (${c.type}).`);
      return `${access.quote(name)} = ${literal(v, c, access)}`;
    });
    if (sets.length) out.push({ sql: `UPDATE ${table} SET ${sets.join(", ")} WHERE ${whereKey(ch.key, pk, access)}`, expect: 1 });
  }

  // Inserts: consecutive rows naming the same columns share one INSERT … VALUES (…), (…).
  let group: { names: string[]; rows: string[] } | null = null;
  const flush = () => {
    if (!group) return;
    out.push({ sql: `INSERT INTO ${table} (${group.names.map((n) => access.quote(n)).join(", ")}) VALUES ${group.rows.join(", ")}`, expect: group.rows.length });
    group = null;
  };
  for (const ch of changes) {
    if (ch.kind !== "insert") continue;
    const names = Object.keys(ch.values);
    for (const n of names) if (!column(columns, n).insertable) throw new EditError(`"${n}" is filled in by the database; leave it empty.`);
    if (!names.length) {
      flush();
      out.push({ sql: `INSERT INTO ${table} DEFAULT VALUES`, expect: 1 });
      continue;
    }
    if (group && (group.names.join("\u0000") !== names.join("\u0000") || group.rows.length >= BATCH_ROWS)) flush();
    group ??= { names, rows: [] };
    group.rows.push(`(${names.map((n) => literal(ch.values[n]!, column(columns, n), access)).join(", ")})`);
  }
  flush();

  const deletes = changes.filter((c): c is Extract<Change, { kind: "delete" }> => c.kind === "delete");
  if (deletes.length && !pk.length) throw new EditError("The table has no primary key, so rows can't be deleted safely.");
  if (pk.length === 1) {
    const c = pk[0]!;
    const col = access.quote(c.name);
    for (let i = 0; i < deletes.length; i += BATCH_ROWS) {
      const keys = deletes.slice(i, i + BATCH_ROWS).map((d) => literal(d.key[c.name] as CellInput, c, access));
      out.push({ sql: keys.length === 1 ? `DELETE FROM ${table} WHERE ${col} = ${keys[0]}` : `DELETE FROM ${table} WHERE ${col} IN (${keys.join(", ")})`, expect: keys.length });
    }
  } else {
    for (const d of deletes) out.push({ sql: `DELETE FROM ${table} WHERE ${whereKey(d.key, pk, access)}`, expect: 1 });
  }
  return out;
}

/** The script the review dialog shows: the statements as they will run, `;`-terminated. */
export const reviewScript = (statements: Statement[]): string => statements.map((s) => `${s.sql};`).join("\n");

/** A user-typed filter goes into the SELECT as is, so it must stay a condition: no second statement, no comments. */
export function checkWhere(where: string | undefined): string | undefined {
  const w = where?.trim();
  if (!w) return undefined;
  if (/;|--|\/\*/.test(w)) throw new EditError("The filter is a condition only — no ';' or comments.");
  return w;
}
