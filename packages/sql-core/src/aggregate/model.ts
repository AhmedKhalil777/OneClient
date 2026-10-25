import { EditError, literal } from "../table-editor/sql.js";
import type { TableAccess, TableColumn, TableTarget } from "../table-editor/types.js";
import { AGGREGATE_VERSION, type AggregateConfig, type ColumnLink, type ForeignKey, type ParentLink, type Relation, type TableRef } from "./types.js";

/** Pure parts of Fast Aggregates: suggesting a configuration from the database's foreign keys, checking one, and the filters that select a parent's children. */

export const sameTable = (a: TableRef, b: TableRef) => a.schema === b.schema && a.table === b.table;
export const tableLabel = (t: TableRef) => t.table;
const idOf = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "rel";

/** "order_items" → "Order items". */
export function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

export interface SuggestOptions {
  /** How many levels below the root to follow (default 2). */
  depth?: number;
  /** Tables to leave out, e.g. audit logs. */
  exclude?: TableRef[];
}

/** A table whose only job is to link two others: two foreign keys that, between them, cover every one of its key columns. */
function joinTable(fks: ForeignKey[], table: TableRef, pk: Map<string, string[]>): [ForeignKey, ForeignKey] | null {
  const own = fks.filter((f) => sameTable(f.table, table));
  if (own.length !== 2) return null;
  const key = pk.get(`${table.schema}.${table.table}`);
  const fkColumns = new Set(own.flatMap((f) => f.columns));
  // A join table has no payload worth its own screen: its key is made of the two foreign keys' columns.
  if (!key || key.length === 0 || !key.every((c) => fkColumns.has(c))) return null;
  return [own[0]!, own[1]!];
}

/**
 * The relations that hang off `parent`: tables pointing at it (one-to-many), and — through join tables — the tables on
 * the other side (many-to-many). `path` guards against cycles: a table already above is not followed again.
 */
function relationsOf(parent: TableRef, fks: ForeignKey[], pk: Map<string, string[]>, depth: number, path: TableRef[], exclude: TableRef[]): Relation[] {
  if (depth <= 0) return [];
  const out: Relation[] = [];
  const used = new Set<string>();
  const unique = (base: string) => {
    let id = idOf(base);
    for (let n = 2; used.has(id); n++) id = `${idOf(base)}${n}`;
    used.add(id);
    return id;
  };
  const here = [...path, parent];
  const skip = (t: TableRef) => exclude.some((e) => sameTable(e, t)) || here.some((p) => sameTable(p, t));

  for (const fk of fks.filter((f) => sameTable(f.refTable, parent))) {
    const child = fk.table;
    const join = joinTable(fks, child, pk);
    if (join) {
      // Many-to-many: the join table is not an entity, the table on its other side is.
      const toParent = join.find((j) => sameTable(j.refTable, parent) && j === fk) ?? fk;
      const toOther = join.find((j) => j !== toParent)!;
      const other = toOther.refTable;
      // Both sides pointing at the same table is a self-referencing link (friends, related products): not suggested.
      if (sameTable(other, parent) || skip(other) || toOther.columns.length !== 1) continue;
      out.push({
        id: unique(other.table),
        label: humanize(other.table),
        kind: "manyToMany",
        table: other,
        link: [],
        via: {
          table: child,
          parent: toParent.columns.map((column, i) => ({ column, parentColumn: toParent.refColumns[i]! })),
          child: [{ column: toOther.columns[0]!, parentColumn: toOther.refColumns[0]! }],
        },
        children: relationsOf(other, fks, pk, depth - 1, here, exclude),
      });
      continue;
    }
    if (skip(child)) continue;
    out.push({
      id: unique(child.table),
      label: humanize(child.table),
      kind: "oneToMany",
      table: child,
      link: fk.columns.map((column, i) => ({ column, parentColumn: fk.refColumns[i]! })),
      children: relationsOf(child, fks, pk, depth - 1, here, exclude),
    });
  }
  return out;
}

/** A configuration for `root`, built from the foreign keys of its database. The user then trims and renames it. */
export function suggestAggregate(database: string, root: TableRef, fks: ForeignKey[], primaryKeys: Map<string, string[]>, opts: SuggestOptions = {}): AggregateConfig {
  return {
    version: AGGREGATE_VERSION,
    name: humanize(root.table),
    database,
    root: { table: root, label: humanize(root.table).replace(/s$/, ""), children: relationsOf(root, fks, primaryKeys, opts.depth ?? 2, [], opts.exclude ?? []) },
  };
}

/** Walks every relation of the tree, depth first. */
export function walkRelations(list: Relation[], visit: (r: Relation, path: Relation[]) => void, path: Relation[] = []): void {
  for (const r of list) {
    visit(r, path);
    walkRelations(r.children, visit, [...path, r]);
  }
}

/** What is wrong with a configuration (loaded from a file someone may have edited); empty = usable. */
export function validateAggregate(c: AggregateConfig): string[] {
  const problems: string[] = [];
  if (!c.name?.trim()) problems.push("The aggregate needs a name.");
  if (!c.database) problems.push("The aggregate needs a database.");
  if (!c.root?.table?.table) problems.push("The aggregate needs a root table.");
  const check = (list: Relation[], where: string) => {
    const ids = new Set<string>();
    for (const r of list) {
      const label = `${where}${r.label || r.id}`;
      if (!/^[A-Za-z0-9_-]+$/.test(r.id ?? "")) problems.push(`${label}: the id may only use letters, digits, '_' and '-'.`);
      else if (ids.has(r.id)) problems.push(`${label}: the id “${r.id}” is used twice at this level.`);
      ids.add(r.id);
      if (!r.table?.table) problems.push(`${label}: no table.`);
      if (r.kind === "oneToMany" && !r.link?.length) problems.push(`${label}: no foreign key columns.`);
      if (r.kind === "manyToMany") {
        if (!r.via?.table?.table || !r.via.parent?.length) problems.push(`${label}: the join table is not set up.`);
        else if (r.via.child?.length !== 1) problems.push(`${label}: the join table must point at the related table with one column.`);
      }
      check(r.children ?? [], `${label} › `);
    }
  };
  check(c.root?.children ?? [], "");
  return problems;
}

/** A configuration read from a file: missing pieces filled in, so older or hand-edited files still open. */
export function normalizeAggregate(raw: unknown): AggregateConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const root = (r.root && typeof r.root === "object" ? r.root : {}) as Record<string, unknown>;
  const relation = (x: unknown): Relation => {
    const q = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const table = (q.table ?? {}) as TableRef;
    return {
      id: typeof q.id === "string" && q.id ? q.id : idOf(table.table ?? "rel"),
      label: typeof q.label === "string" && q.label ? q.label : humanize(table.table ?? "rel"),
      kind: q.kind === "manyToMany" ? "manyToMany" : "oneToMany",
      table,
      link: Array.isArray(q.link) ? (q.link as ColumnLink[]) : [],
      ...(q.via && typeof q.via === "object" ? { via: q.via as NonNullable<Relation["via"]> } : {}),
      ...(Array.isArray(q.columns) ? { columns: (q.columns as unknown[]).map(String) } : {}),
      children: Array.isArray(q.children) ? (q.children as unknown[]).map(relation) : [],
    };
  };
  return {
    version: AGGREGATE_VERSION,
    name: typeof r.name === "string" ? r.name : "Aggregate",
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    database: typeof r.database === "string" ? r.database : "",
    root: {
      table: (root.table ?? { schema: "", table: "" }) as TableRef,
      ...(typeof root.label === "string" ? { label: root.label } : {}),
      ...(Array.isArray(root.columns) ? { columns: (root.columns as unknown[]).map(String) } : {}),
      children: Array.isArray(root.children) ? (root.children as unknown[]).map(relation) : [],
    },
  };
}

// ---------------------------------------------------------------------------------------------- messages

export interface FriendlyError {
  /** What went wrong, in a sentence a user can act on. */
  summary: string;
  /** The database's own message, for Details. */
  detail: string;
}

/**
 * Database errors are precise but not helpful ("The INSERT statement conflicted with the FOREIGN KEY constraint
 * FK__orders__customer__48CFD27E…"). The common ones — a missing parent, a row still in use, a duplicate, a required
 * value left empty — become one plain sentence; anything else is shown as it came.
 */
export function friendlyError(message: string): FriendlyError {
  const m = message.trim();
  const detail = m;
  const first = (s: string) => ({ summary: s, detail });

  // A row points at a parent that doesn't exist (PostgreSQL, SQL Server, MySQL).
  let x = /insert or update on table "([^"]+)" violates foreign key constraint/i.exec(m);
  if (x) return first(`A value points to a row that doesn't exist (${x[1]} references another table). Pick an existing one, or create it first.`);
  x = /(?:INSERT|UPDATE) statement conflicted with the FOREIGN KEY constraint "[^"]+"\. The conflict occurred in database "[^"]*", table "([^"]+)", column '([^']+)'/i.exec(m);
  if (x) return first(`No row in ${x[1]} has ${x[2]} equal to that value. Pick an existing one, or create it first.`);
  if (/Cannot add or update a child row: a foreign key constraint fails/i.test(m)) return first("A value points to a row that doesn't exist. Pick an existing one, or create it first.");

  // A row is still used by others.
  x = /update or delete on table "([^"]+)" violates foreign key constraint "[^"]+" on table "([^"]+)"/i.exec(m);
  if (x) return first(`Can't change or delete this ${x[1]} row: rows in ${x[2]} still use it. Remove those first, or delete with related rows.`);
  x = /(?:DELETE|UPDATE) statement conflicted with the (?:REFERENCE|FOREIGN KEY) constraint "[^"]+"\. The conflict occurred in database "[^"]*", table "([^"]+)"/i.exec(m);
  if (x) return first(`Can't change or delete this row: rows in ${x[1]} still use it. Remove those first, or delete with related rows.`);
  if (/Cannot delete or update a parent row: a foreign key constraint fails/i.test(m)) return first("Can't change or delete this row: other rows still use it. Remove those first, or delete with related rows.");

  // Duplicates.
  x = /duplicate key value violates unique constraint "([^"]+)"(?:[\s\S]*Key \(([^)]+)\)=\(([^)]*)\) already exists)?/i.exec(m);
  if (x) return first(x[2] ? `Another row already has ${x[2]} = ${x[3]}. It must be unique.` : `That value already exists — it must be unique (${x[1]}).`);
  x = /Violation of (?:UNIQUE KEY|PRIMARY KEY) constraint ["']([^"']+)["'][\s\S]*duplicate key value is \(([^)]*)\)/i.exec(m);
  if (x) return first(`Another row already has the value ${x[2]}. It must be unique.`);
  x = /Duplicate entry '([^']*)' for key/i.exec(m);
  if (x) return first(`Another row already has the value ${x[1]}. It must be unique.`);

  // Required values.
  x = /null value in column "([^"]+)"/i.exec(m) ?? /Cannot insert the value NULL into column '([^']+)'/i.exec(m) ?? /Column '([^']+)' cannot be null/i.exec(m) ?? /Field '([^']+)' doesn't have a default value/i.exec(m);
  if (x) return first(`${x[1]} is required — give it a value.`);

  // Rules and types.
  x = /violates check constraint "([^"]+)"/i.exec(m) ?? /conflicted with the CHECK constraint "([^"]+)"/i.exec(m);
  if (x) return first(`A value breaks a rule of the table (${x[1]}).`);
  if (/invalid input syntax for type|Conversion failed when converting|Incorrect (?:integer|decimal|datetime|date) value|out of range/i.test(m)) return first("A value doesn't fit its column's type (a number, a date…). Check the highlighted fields.");
  if (/String or binary data would be truncated|value too long for type|Data too long for column/i.test(m)) return first("A text value is longer than its column allows.");
  if (/deadlock|lock timeout|Lock wait timeout/i.test(m)) return first("The database was busy with another change. Try again.");
  if (/expected \d+ row\(s\)|should have changed \d+ row/i.test(m)) return first("The data changed while you were editing (someone else may have saved or deleted it). Reload and try again.");

  const line = m.split(/\r?\n/)[0] ?? m;
  return first(line.length > 200 ? `${line.slice(0, 200)}…` : line);
}

/**
 * A plain search over a table's text columns (and the key, if a number is typed): rows where any text column contains the
 * words, case-insensitively. For people who don't want to write a SQL condition.
 */
export function searchFilter(columns: TableColumn[], text: string, access: TableAccess): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const parts: string[] = [];
  // Many columns on one OR slow a big table: the first few text columns are what people mean.
  for (const c of columns.filter((x) => x.kind === "text" && !/^(ntext|image)$/i.test(x.type)).slice(0, 6)) {
    parts.push(`LOWER(${access.quote(c.name)}) LIKE ${literal(`%${t.toLowerCase()}%`, c, access)}`);
  }
  if (/^-?\d+$/.test(t)) {
    for (const c of columns.filter((x) => x.kind === "number" && x.isPk)) parts.push(`${access.quote(c.name)} = ${t}`);
  }
  return parts.length ? `(${parts.join(" OR ")})` : "1 = 0";
}

// ---------------------------------------------------------------------------------------------- parents

const NAME_COLUMNS = ["name", "title", "number", "code", "label", "email", "description"];

/**
 * The column of `columns` that best names a row: a well-known one, else the first text column that is not the key (a
 * short one before a "large" one — PostgreSQL counts plain text / varchar as large), else none (the key is shown).
 */
export function displayColumn(columns: TableColumn[]): string | null {
  const text = columns.filter((c) => c.kind === "text");
  for (const n of NAME_COLUMNS) {
    const c = text.find((x) => x.name.toLowerCase() === n);
    if (c) return c.name;
  }
  const rest = text.filter((c) => !c.isPk);
  return (rest.find((c) => !c.lob) ?? rest[0])?.name ?? null;
}

/** The single-column foreign keys of `table`, as links to pick a parent row from (composite keys stay as plain inputs). */
export function parentLinks(table: TableRef, fks: ForeignKey[], columnsOf: Lookup): ParentLink[] {
  const out: ParentLink[] = [];
  for (const fk of fks) {
    if (!sameTable(fk.table, table) || fk.columns.length !== 1 || fk.refColumns.length !== 1) continue;
    let display: string | null = null;
    try {
      display = displayColumn(columnsOf(fk.refTable));
    } catch {
      /* the parent can't be described: fall back to its key */
    }
    out.push({ column: fk.columns[0]!, refTable: fk.refTable, refColumn: fk.refColumns[0]!, display });
  }
  return out;
}

/** How a parent row is shown in the picker: its name and key, "Ann Lee (#1)" — or just the key when it has no name. */
export function optionLabel(name: unknown, value: string): string {
  // A "large" text column arrives cut (a preview object) when it is huge; a long name is shortened either way.
  const raw = name === null || name === undefined ? "" : typeof name === "object" && "preview" in (name as object) ? String((name as { preview: unknown }).preview) : String(name);
  const text = raw.replace(/\s+/g, " ").trim();
  return text ? `${text.length > 70 ? `${text.slice(0, 70)}…` : text} (#${value})` : value;
}

/**
 * The condition that finds the row just inserted when the database chose its key (identity / serial): every value the
 * user gave that can be compared exactly. The newest match is the one — the caller orders by key, newest first.
 */
export function justInsertedFilter(values: Record<string, unknown>, columns: TableColumn[], access: TableAccess): string | undefined {
  const parts: string[] = [];
  for (const c of columns) {
    const v = values[c.name];
    if (v === undefined || v === null || v === "" || c.lob || !["text", "number", "bool"].includes(c.kind)) continue;
    parts.push(`${access.quote(c.name)} = ${literal(typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v), c, access)}`);
  }
  return parts.length ? parts.join(" AND ") : undefined;
}

/**
 * The condition that finds parent rows: by key when `value` is given (to name the row already chosen), else by what the
 * user typed — text matched against the display column, and a number against the key. The text goes in as a literal.
 */
export function parentFilter(link: ParentLink, columns: TableColumn[], access: TableAccess, input: { value?: string; search?: string }): string | undefined {
  const key = columnOf(columns, link.refColumn, link.refTable);
  if (input.value !== undefined && input.value !== "") return `${access.quote(key.name)} = ${literal(input.value, key, access)}`;
  const text = (input.search ?? "").trim();
  if (!text) return undefined;
  const parts: string[] = [];
  if (link.display) {
    const d = columnOf(columns, link.display, link.refTable);
    // LOWER on both sides: PostgreSQL's LIKE is case-sensitive, SQL Server's and MySQL's usually are not.
    parts.push(`LOWER(${access.quote(d.name)}) LIKE ${literal(`%${text.toLowerCase()}%`, d, access)}`);
  }
  if (key.kind === "number" && /^-?\d+$/.test(text)) parts.push(`${access.quote(key.name)} = ${text}`);
  else if (key.kind === "text" && !link.display) parts.push(`LOWER(${access.quote(key.name)}) LIKE ${literal(`%${text.toLowerCase()}%`, key, access)}`);
  return parts.length ? `(${parts.join(" OR ")})` : "1 = 0";
}

// ---------------------------------------------------------------------------------------------- filters

type Lookup = (table: TableRef) => TableColumn[];

function columnOf(columns: TableColumn[], name: string, table: TableRef): TableColumn {
  const c = columns.find((x) => x.name === name);
  if (!c) throw new EditError(`Unknown column "${name}" in ${table.schema}.${table.table} — has the table changed since this aggregate was set up?`);
  return c;
}

/** `col = literal AND …` for the link's columns, with the parent's values read from the row being opened. */
function equalities(links: ColumnLink[], side: "column" | "parentColumn", values: Record<string, unknown>, columns: TableColumn[], table: TableRef, valueKey: "parentColumn" | "column", access: TableAccess): string {
  return links
    .map((l) => {
      const col = columnOf(columns, l[side], table);
      const v = values[l[valueKey]];
      if (v === null || v === undefined) throw new EditError(`The ${valueKey === "parentColumn" ? "parent" : "related"} row has no value for "${l[valueKey]}".`);
      return `${access.quote(col.name)} = ${literal(typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v), col, access)}`;
    })
    .join(" AND ");
}

/**
 * The WHERE condition (without the word) that selects `relation`'s rows for one parent row. `parentValues` holds the
 * parent's column values by name. One-to-many compares the child's foreign key with the parent's key; many-to-many
 * asks the join table. Every column name is checked against the table's real columns before it is quoted into SQL.
 */
export function childFilter(relation: Relation, parentValues: Record<string, unknown>, columnsOf: Lookup, access: TableAccess, target: Pick<TableTarget, "database">): string {
  if (relation.kind === "oneToMany") {
    return equalities(relation.link, "column", parentValues, columnsOf(relation.table), relation.table, "parentColumn", access);
  }
  const via = relation.via!;
  const viaTable = { ...target, ...via.table };
  const childCol = via.child[0]!;
  const related = columnOf(columnsOf(relation.table), childCol.parentColumn, relation.table);
  const joinColumns = columnsOf(via.table);
  const toChild = columnOf(joinColumns, childCol.column, via.table);
  const where = equalities(via.parent, "column", parentValues, joinColumns, via.table, "parentColumn", access);
  return `${access.quote(related.name)} IN (SELECT ${access.quote(toChild.name)} FROM ${access.qualify(viaTable)} WHERE ${where})`;
}

/** The rows that could still be linked to this parent through a many-to-many relation (the ones the join table doesn't have yet). */
export function candidateFilter(relation: Relation, parentValues: Record<string, unknown>, columnsOf: Lookup, access: TableAccess, target: Pick<TableTarget, "database">): string {
  if (relation.kind !== "manyToMany") throw new EditError("Only many-to-many relations link existing rows.");
  return `NOT (${childFilter(relation, parentValues, columnsOf, access, target)})`;
}

/** The values to insert into the join table to link `parentValues` with the related row `childValues`. */
export function linkRow(relation: Relation, parentValues: Record<string, unknown>, childValues: Record<string, unknown>): Record<string, string | number | boolean> {
  if (relation.kind !== "manyToMany" || !relation.via) throw new EditError("Only many-to-many relations link existing rows.");
  const out: Record<string, string | number | boolean> = {};
  const put = (column: string, v: unknown, what: string) => {
    if (v === null || v === undefined) throw new EditError(`The ${what} row has no value for the join column "${column}".`);
    out[column] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v);
  };
  for (const l of relation.via.parent) put(l.column, parentValues[l.parentColumn], "parent");
  for (const l of relation.via.child) put(l.column, childValues[l.parentColumn], "related");
  return out;
}

/** For a new row in a one-to-many child: the foreign key columns pre-filled from the parent. */
export function inheritedValues(relation: Relation, parentValues: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (relation.kind !== "oneToMany") return out;
  for (const l of relation.link) {
    const v = parentValues[l.parentColumn];
    if (v !== null && v !== undefined) out[l.column] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v);
  }
  return out;
}

/** Groups one-row-per-column foreign key rows (what SQL Server and MySQL catalogs give) into foreign keys. */
export function groupForeignKeys(rows: Array<{ name: string; schema: string; table: string; refSchema: string; refTable: string; column: string; refColumn: string }>): ForeignKey[] {
  const map = new Map<string, ForeignKey>();
  for (const r of rows) {
    const key = `${r.schema}.${r.table}.${r.name}`;
    let fk = map.get(key);
    if (!fk) map.set(key, (fk = { name: r.name, table: { schema: r.schema, table: r.table }, columns: [], refTable: { schema: r.refSchema, table: r.refTable }, refColumns: [] }));
    fk.columns.push(r.column);
    fk.refColumns.push(r.refColumn);
  }
  return [...map.values()];
}
