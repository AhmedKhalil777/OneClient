import type pg from "pg";
import { qualified, quoteIdent } from "./config.js";

export interface DatabaseRow {
  name: string;
  allowConn: boolean;
  isTemplate: boolean;
}
export type ObjectKind = "tables" | "views" | "matviews" | "functions" | "procedures" | "sequences";
export interface ObjectRow {
  schema: string;
  name: string;
  /** Functions / procedures: identity arguments ("integer, text"), to tell overloads apart. */
  args?: string;
  /** Functions / procedures: argument types only ("integer, text") — how the overload is looked up. */
  sig?: string;
  /** Functions: return type. */
  returns?: string;
}
export interface ColumnRow {
  name: string;
  type: string;
  nullable: boolean;
  identity: string; // "" | "a" (ALWAYS) | "d" (BY DEFAULT)
  generated: boolean;
  isPk: boolean;
  isFk: boolean;
  default: string | null;
}
export interface IndexRow {
  name: string;
  method: string;
  isUnique: boolean;
  isPrimary: boolean;
  definition: string;
}
export interface ConstraintRow {
  name: string;
  type: string; // p, f, u, c, x
  definition: string;
}

const SYSTEM_SCHEMA = `(n.nspname IN ('pg_catalog','information_schema') OR n.nspname LIKE 'pg\\_toast%' OR n.nspname LIKE 'pg\\_temp\\_%')`;

export async function listDatabases(pool: pg.Pool): Promise<DatabaseRow[]> {
  const r = await pool.query<DatabaseRow>(`SELECT datname AS name, datallowconn AS "allowConn", datistemplate AS "isTemplate" FROM pg_database ORDER BY datname`);
  return r.rows;
}

export async function listSchemas(pool: pg.Pool, system: boolean): Promise<string[]> {
  const r = await pool.query<{ name: string }>(
    `SELECT n.nspname AS name FROM pg_namespace n WHERE ${system ? "" : "NOT "}${SYSTEM_SCHEMA} AND n.nspname NOT LIKE 'pg\\_toast\\_temp%' ORDER BY n.nspname`,
  );
  return r.rows.map((x) => x.name);
}

const RELKINDS: Partial<Record<ObjectKind, string>> = { tables: "'r','p','f'", views: "'v'", matviews: "'m'", sequences: "'S'" };

/** Objects of one kind in one schema, sorted by name. */
export async function listObjects(pool: pg.Pool, schema: string, kind: ObjectKind): Promise<ObjectRow[]> {
  const relkinds = RELKINDS[kind];
  if (relkinds) {
    const r = await pool.query<ObjectRow>(
      `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN (${relkinds}) AND NOT c.relispartition
          ${kind === "sequences" ? "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a','i'))" : ""}
        ORDER BY c.relname`,
      [schema],
    );
    return r.rows;
  }
  const r = await pool.query<ObjectRow>(
    `SELECT n.nspname AS schema, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, oidvectortypes(p.proargtypes) AS sig, pg_get_function_result(p.oid) AS returns
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
      WHERE n.nspname = $1 AND p.prokind = $2 AND d.objid IS NULL
      ORDER BY p.proname, args`,
    [schema, kind === "procedures" ? "p" : "f"],
  );
  return r.rows;
}

const relation = (schema: string, name: string) => qualified(schema, name);

export async function listColumns(pool: pg.Pool, schema: string, name: string): Promise<ColumnRow[]> {
  const r = await pool.query<ColumnRow>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
            a.attidentity AS identity, a.attgenerated <> '' AS generated,
            EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = a.attrelid AND k.contype = 'p' AND a.attnum = ANY (k.conkey)) AS "isPk",
            EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = a.attrelid AND k.contype = 'f' AND a.attnum = ANY (k.conkey)) AS "isFk",
            pg_get_expr(ad.adbin, ad.adrelid) AS default
       FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [relation(schema, name)],
  );
  return r.rows;
}

export async function listIndexes(pool: pg.Pool, schema: string, name: string): Promise<IndexRow[]> {
  const r = await pool.query<IndexRow>(
    `SELECT ic.relname AS name, am.amname AS method, i.indisunique AS "isUnique", i.indisprimary AS "isPrimary", pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
      WHERE i.indrelid = $1::regclass
      ORDER BY i.indisprimary DESC, ic.relname`,
    [relation(schema, name)],
  );
  return r.rows;
}

export async function listConstraints(pool: pg.Pool, schema: string, name: string): Promise<ConstraintRow[]> {
  const r = await pool.query<ConstraintRow>(
    `SELECT conname AS name, contype AS type, pg_get_constraintdef(oid, true) AS definition FROM pg_constraint
      WHERE conrelid = $1::regclass ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, conname`,
    [relation(schema, name)],
  );
  return r.rows;
}

/** CREATE TABLE with columns, constraints, indexes and comments — close to what pg_dump writes. */
export async function scriptTable(pool: pg.Pool, schema: string, name: string): Promise<string> {
  const [cols, constraints, indexes, comment] = await Promise.all([
    listColumns(pool, schema, name),
    listConstraints(pool, schema, name),
    listIndexes(pool, schema, name),
    pool.query<{ c: string | null }>(`SELECT obj_description($1::regclass, 'pg_class') AS c`, [relation(schema, name)]),
  ]);
  const lines = cols.map((c) => {
    const parts = [`    ${quoteIdent(c.name)} ${c.type}`];
    if (c.generated) parts.push(`GENERATED ALWAYS AS (${c.default}) STORED`);
    else if (c.identity) parts.push(`GENERATED ${c.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`);
    else if (c.default) parts.push(`DEFAULT ${c.default}`);
    if (!c.nullable) parts.push("NOT NULL");
    return parts.join(" ");
  });
  for (const k of constraints.filter((x) => x.type !== "f" && x.type !== "n")) lines.push(`    CONSTRAINT ${quoteIdent(k.name)} ${k.definition}`);
  const target = relation(schema, name);
  let sql = `CREATE TABLE ${target} (\n${lines.join(",\n")}\n);\n`;
  for (const k of constraints.filter((x) => x.type === "f")) sql += `\nALTER TABLE ${target}\n    ADD CONSTRAINT ${quoteIdent(k.name)} ${k.definition};\n`;
  const constraintNames = new Set(constraints.map((k) => k.name));
  for (const i of indexes.filter((x) => !constraintNames.has(x.name))) sql += `\n${i.definition};\n`;
  const text = comment.rows[0]?.c;
  if (text) sql += `\nCOMMENT ON TABLE ${target} IS '${text.replace(/'/g, "''")}';\n`;
  return sql;
}

/** The oid of one function / procedure overload, by its argument types ("integer, text"). */
async function routineOid(pool: pg.Pool, schema: string, name: string, sig: string): Promise<number> {
  const r = await pool.query<{ oid: number }>(
    `SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2 AND oidvectortypes(p.proargtypes) = $3`,
    [schema, name, sig],
  );
  const oid = r.rows[0]?.oid;
  if (oid === undefined) throw new Error(`${schema}.${name}(${sig}) doesn't exist (any more).`);
  return oid;
}

/** CREATE OR REPLACE for a view, materialized view, sequence, function or procedure. */
export async function objectDefinition(pool: pg.Pool, kind: ObjectKind, schema: string, name: string, sig = ""): Promise<string | null> {
  if (kind === "views" || kind === "matviews") {
    const r = await pool.query<{ d: string | null }>(`SELECT pg_get_viewdef($1::regclass, true) AS d`, [relation(schema, name)]);
    const body = r.rows[0]?.d;
    if (!body) return null;
    return kind === "views"
      ? `CREATE OR REPLACE VIEW ${relation(schema, name)} AS\n${body.trimEnd()}\n`
      : `-- Materialized views can't be replaced: drop and re-create.\n-- DROP MATERIALIZED VIEW ${relation(schema, name)};\nCREATE MATERIALIZED VIEW ${relation(schema, name)} AS\n${body.trimEnd()}\n`;
  }
  if (kind === "sequences") {
    const r = await pool.query<{ start_value: string; increment_by: string; min_value: string; max_value: string; cache_size: string; cycle: boolean; data_type: string }>(
      `SELECT start_value, increment_by, min_value, max_value, cache_size, cycle, data_type FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`,
      [schema, name],
    );
    const s = r.rows[0];
    if (!s) return null;
    return `CREATE SEQUENCE ${relation(schema, name)}\n    AS ${s.data_type}\n    START WITH ${s.start_value}\n    INCREMENT BY ${s.increment_by}\n    MINVALUE ${s.min_value}\n    MAXVALUE ${s.max_value}\n    CACHE ${s.cache_size}${s.cycle ? "\n    CYCLE" : ""};\n`;
  }
  const r = await pool.query<{ d: string }>(`SELECT pg_get_functiondef($1::oid) AS d`, [await routineOid(pool, schema, name, sig)]);
  return r.rows[0]?.d ?? null;
}

export interface Parameter {
  name: string;
  type: string;
  mode: string; // i, o, b, v, t
}

/** IN / INOUT parameters of a function or procedure, for a SELECT / CALL script. */
export async function listParameters(pool: pg.Pool, schema: string, name: string, sig: string): Promise<Parameter[]> {
  const r = await pool.query<{ names: string[] | null; types: string[]; modes: string[] | null }>(
    `SELECT p.proargnames AS names, ARRAY(SELECT format_type(t, NULL) FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])) t) AS types, p.proargmodes::text[] AS modes
       FROM pg_proc p WHERE p.oid = $1::oid`,
    [await routineOid(pool, schema, name, sig)],
  );
  const row = r.rows[0];
  if (!row) return [];
  // pg_type arrays come back as text ("{a,b}") because our type parsers keep server text; parse them.
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? parseArray(v) : []);
  const names = arr(row.names);
  const types = arr(row.types);
  const modes = arr(row.modes);
  return types.map((type, i) => ({ name: names[i] || `p${i + 1}`, type, mode: modes[i] ?? "i" }));
}

/** Parses a one-dimensional PostgreSQL array literal: {a,"b c",NULL}. */
export function parseArray(text: string): string[] {
  const inner = text.trim().replace(/^\{/, "").replace(/\}$/, "");
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
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export interface CompletionCatalog {
  database: string;
  schemas: string[];
  /** The session's search_path schemas, in order — unqualified names resolve against these. */
  searchPath: string[];
  objects: Array<{ schema: string; name: string; kind: "table" | "view" | "procedure" | "function" }>;
  columns: Array<{ schema: string; object: string; name: string; type: string }>;
  truncated: boolean;
}

const MAX_CATALOG_COLUMNS = 50_000;

/** Everything the query editor's IntelliSense needs for one database. */
export async function completionCatalog(pool: pg.Pool): Promise<CompletionCatalog> {
  const [db, schemas, objects, columns] = await Promise.all([
    pool.query<{ db: string; path: string }>(`SELECT current_database() AS db, array_to_string(current_schemas(false), ',') AS path`),
    pool.query<{ name: string }>(`SELECT n.nspname AS name FROM pg_namespace n WHERE NOT ${SYSTEM_SCHEMA} ORDER BY 1`),
    pool.query<{ schema: string; name: string; kind: string }>(
      `SELECT n.nspname AS schema, c.relname AS name, CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p','f','v','m') AND NOT c.relispartition AND NOT ${SYSTEM_SCHEMA}
       UNION ALL
       SELECT DISTINCT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
        WHERE p.prokind IN ('f','p') AND NOT ${SYSTEM_SCHEMA} AND d.objid IS NULL`,
    ),
    pool.query<{ schema: string; object: string; name: string; type: string }>(
      `SELECT n.nspname AS schema, c.relname AS object, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p','f','v','m') AND a.attnum > 0 AND NOT a.attisdropped AND NOT ${SYSTEM_SCHEMA}
        ORDER BY c.oid, a.attnum LIMIT ${MAX_CATALOG_COLUMNS + 1}`,
    ),
  ]);
  return {
    database: db.rows[0]?.db ?? "",
    schemas: schemas.rows.map((s) => s.name),
    searchPath: (db.rows[0]?.path ?? "public").split(",").filter(Boolean),
    objects: objects.rows.map((o) => ({ schema: o.schema, name: o.name, kind: o.kind as "table" })),
    columns: columns.rows.slice(0, MAX_CATALOG_COLUMNS),
    truncated: columns.rows.length > MAX_CATALOG_COLUMNS,
  };
}
