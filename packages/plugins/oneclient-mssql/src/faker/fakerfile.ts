import type { ChildRule, ColumnRule, GeneratorKind, TableRule } from "./rules.js";

/**
 * The `*.faker.json` file format — what a faker looks like on disk (hand-editable, diff-friendly, shareable):
 *
 *   {
 *     "format": "oneclient-faker",
 *     "version": 1,
 *     "name": "Customers with orders",
 *     "database": "Shop",                       // optional: where it shows up / runs by default
 *     "table": "dbo.Customers",
 *     "count": 50,
 *     "seed": 42,                               // optional: same seed → same data
 *     "columns": {                              // optional: unlisted columns get the automatic suggestion
 *       "email":        { "kind": "faker", "fakerId": "internet.email" },
 *       "country_code": { "kind": "fk-existing" },
 *       "tier":         { "kind": "pick", "value": "gold, silver, bronze" }
 *     },
 *     "children": [                             // nested rows per customer
 *       { "table": "dbo.Orders", "via": "customer_id", "min": 1, "max": 5,
 *         "columns": { "status": { "kind": "pick", "value": "new, paid" } },
 *         "children": [{ "table": "dbo.OrderLines", "via": "order_id", "min": 1, "max": 4 }] }
 *     ]
 *   }
 *
 * A foreign key can also create its parent rows: `{ "kind": "fk-new", "parentCount": 5, "parent": { "table": "dbo.Countries", "columns": {…} } }`.
 */
export const FAKER_FORMAT = "oneclient-faker";
/** Bump, and add a step to `migrate`, when the file shape changes. */
export const FAKER_VERSION = 1;

export type ColumnSpec = Omit<ColumnRule, "column" | "parent"> & { parent?: TableSpec };
export interface TableSpec {
  table: string;
  columns?: Record<string, ColumnSpec>;
  children?: ChildSpec[];
}
export interface ChildSpec extends TableSpec {
  via: string;
  min?: number;
  max?: number;
}
export interface FakerFile extends TableSpec {
  format: typeof FAKER_FORMAT;
  version: number;
  name: string;
  database?: string;
  count: number;
  seed?: number;
}

/** What the app works with once a file is read. */
export interface FakerDoc {
  name: string;
  database?: string | undefined;
  count: number;
  seed?: number | undefined;
  rule: TableRule;
}

export class FakerFileError extends Error {}

const KINDS = new Set<GeneratorKind>(["skip", "null", "constant", "faker", "integer", "decimal", "date", "boolean", "guid", "sequence", "pick", "text", "fk-existing", "fk-new"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** "dbo.Customers", "[dbo].[My Table]", or "Customers" (dbo) → schema + table. */
export function splitTableName(name: string): { schema: string; table: string } {
  const parts: string[] = [];
  const re = /\[((?:[^\]]|\]\])*)\]|([^.[\]]+)/g;
  for (const m of name.trim().matchAll(re)) parts.push((m[1] ?? m[2] ?? "").replace(/\]\]/g, "]").trim());
  const clean = parts.filter(Boolean);
  if (clean.length === 0) throw new FakerFileError(`"${name}" is not a table name.`);
  return clean.length === 1 ? { schema: "dbo", table: clean[0]! } : { schema: clean[clean.length - 2]!, table: clean[clean.length - 1]! };
}

const joinTableName = (schema: string, table: string) => `${/[.[\]\s]/.test(schema) ? `[${schema}]` : schema}.${/[.[\]\s]/.test(table) ? `[${table}]` : table}`;

function columnFromSpec(column: string, spec: unknown, where: string): ColumnRule {
  if (!isObject(spec)) throw new FakerFileError(`${where}: column "${column}" must be an object like { "kind": "…" }.`);
  const kind = spec.kind as GeneratorKind;
  if (!KINDS.has(kind)) throw new FakerFileError(`${where}: column "${column}" has unknown kind "${String(spec.kind)}".`);
  const rule: ColumnRule = { column, kind };
  for (const key of ["fakerId", "value", "from", "to"] as const) if (typeof spec[key] === "string") rule[key] = spec[key] as string;
  for (const key of ["min", "max", "decimals", "start", "step", "nullPercent", "parentCount"] as const) if (typeof spec[key] === "number") rule[key] = spec[key] as number;
  if (spec.parent !== undefined) rule.parent = tableFromSpec(spec.parent, `${where} → ${column}.parent`);
  return rule;
}

function tableFromSpec(spec: unknown, where: string): TableRule {
  if (!isObject(spec) || typeof spec.table !== "string") throw new FakerFileError(`${where}: "table" is missing.`);
  const { schema, table } = splitTableName(spec.table);
  const columns = isObject(spec.columns) ? Object.entries(spec.columns).map(([c, v]) => columnFromSpec(c, v, `${where} (${spec.table})`)) : [];
  const rule: TableRule = { schema, table, columns };
  if (Array.isArray(spec.children)) {
    rule.children = spec.children.map((c, i): ChildRule => {
      const t = tableFromSpec(c, `${where} → children[${i}]`);
      const cs = c as Record<string, unknown>;
      if (typeof cs.via !== "string" || !cs.via) throw new FakerFileError(`${where} → children[${i}]: "via" (the child's foreign key column) is missing.`);
      const min = typeof cs.min === "number" ? cs.min : 1;
      const max = typeof cs.max === "number" ? cs.max : Math.max(min, 3);
      return { ...t, via: cs.via, min, max };
    });
  }
  return rule;
}

function migrate(raw: Record<string, unknown>, where: string): Record<string, unknown> {
  const version = typeof raw.version === "number" ? raw.version : 1;
  if (version > FAKER_VERSION) throw new FakerFileError(`${where} was written by a newer version of oneClient (faker format ${version}).`);
  // v1 is the first format; future versions migrate here step by step.
  return raw;
}

/** Parses and validates a faker file. */
export function readFakerFile(raw: unknown, where = "faker file"): FakerDoc {
  if (!isObject(raw)) throw new FakerFileError(`${where} is not a JSON object.`);
  if (raw.format !== undefined && raw.format !== FAKER_FORMAT) throw new FakerFileError(`${where} is not a oneClient faker (format "${String(raw.format)}").`);
  const doc = migrate(raw, where);
  const rule = tableFromSpec(doc, where);
  const count = typeof doc.count === "number" && doc.count >= 1 ? Math.round(doc.count) : 100;
  const name = typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : `${rule.table} faker`;
  return {
    name,
    ...(typeof doc.database === "string" && doc.database ? { database: doc.database } : {}),
    count,
    ...(typeof doc.seed === "number" ? { seed: doc.seed } : {}),
    rule,
  };
}

function columnToSpec(r: ColumnRule): ColumnSpec {
  const { column: _c, parent, ...rest } = r;
  const spec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== "") spec[k] = v;
  if (parent) spec.parent = tableToSpec(parent);
  return spec as unknown as ColumnSpec;
}

function tableToSpec(rule: TableRule): TableSpec {
  const spec: TableSpec = { table: joinTableName(rule.schema, rule.table) };
  if (rule.columns.length) spec.columns = Object.fromEntries(rule.columns.map((c) => [c.column, columnToSpec(c)]));
  if (rule.children?.length) spec.children = rule.children.map((c) => ({ ...tableToSpec(c), via: c.via, min: c.min, max: c.max }));
  return spec;
}

/** The file content for a faker (stable key order, so files diff nicely). */
export function writeFakerFile(doc: FakerDoc): FakerFile {
  const body = tableToSpec(doc.rule);
  return {
    format: FAKER_FORMAT,
    version: FAKER_VERSION,
    name: doc.name,
    ...(doc.database ? { database: doc.database } : {}),
    table: body.table,
    count: doc.count,
    ...(doc.seed !== undefined ? { seed: doc.seed } : {}),
    ...(body.columns ? { columns: body.columns } : {}),
    ...(body.children ? { children: body.children } : {}),
  };
}
