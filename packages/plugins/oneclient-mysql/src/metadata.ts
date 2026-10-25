import type mysql from "mysql2/promise";
import { SYSTEM_DATABASES, qualified, quoteIdent } from "./config.js";

export type ObjectKind = "tables" | "views" | "functions" | "procedures";

const SYSTEM_LIST = SYSTEM_DATABASES.map((d) => `'${d}'`).join(",");

/** Runs a query and returns its rows (mysql2 gives [rows, fields]). */
async function rows<T>(pool: mysql.Pool, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = (await pool.query(sql, params)) as unknown as [T[]];
  return r;
}

export interface DatabaseRow {
  name: string;
  isSystem: boolean;
}

export async function listDatabases(pool: mysql.Pool): Promise<DatabaseRow[]> {
  const r = await rows<{ name: string }>(pool, "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME");
  return r.map((d) => ({ name: d.name, isSystem: SYSTEM_DATABASES.includes(d.name.toLowerCase()) }));
}

export interface ObjectRow {
  name: string;
  /** Routines: the declared return type (functions). */
  returns?: string | undefined;
}

/** Objects of one kind in one database, sorted by name. */
export async function listObjects(pool: mysql.Pool, database: string, kind: ObjectKind): Promise<ObjectRow[]> {
  if (kind === "tables" || kind === "views") {
    const types = kind === "tables" ? "'BASE TABLE','SYSTEM VERSIONED'" : "'VIEW'";
    return rows<ObjectRow>(pool, `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN (${types}) ORDER BY TABLE_NAME`, [database]);
  }
  return rows<ObjectRow>(pool, `SELECT ROUTINE_NAME AS name, DTD_IDENTIFIER AS returns FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ? ORDER BY ROUTINE_NAME`, [database, kind === "procedures" ? "PROCEDURE" : "FUNCTION"]);
}

export interface ColumnRow {
  name: string;
  /** "int unsigned", "varchar(255)", "enum('a','b')". */
  type: string;
  nullable: boolean;
  isPk: boolean;
  isFk: boolean;
  autoIncrement: boolean;
  /** STORED / VIRTUAL GENERATED columns can't be written. */
  generated: boolean;
  default: string | null;
  extra: string;
}

export async function listColumns(pool: mysql.Pool, database: string, table: string): Promise<ColumnRow[]> {
  const r = await rows<{ name: string; type: string; nullable: number; key: string; extra: string; dflt: string | null; fk: number }>(
    pool,
    `SELECT c.COLUMN_NAME AS name, c.COLUMN_TYPE AS type, c.IS_NULLABLE = 'YES' AS nullable, c.COLUMN_KEY AS \`key\`, c.EXTRA AS extra, c.COLUMN_DEFAULT AS dflt,
            EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k
                     WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL) AS fk
       FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
      ORDER BY c.ORDINAL_POSITION`,
    [database, table],
  );
  return r.map((c) => ({
    name: c.name,
    type: c.type,
    nullable: !!c.nullable,
    isPk: c.key === "PRI",
    isFk: !!c.fk,
    autoIncrement: /auto_increment/i.test(c.extra),
    generated: /\b(VIRTUAL|STORED) GENERATED\b/i.test(c.extra),
    default: c.dflt,
    extra: c.extra,
  }));
}

export interface IndexRow {
  name: string;
  unique: boolean;
  primary: boolean;
  method: string;
  columns: string[];
}

export async function listIndexes(pool: mysql.Pool, database: string, table: string): Promise<IndexRow[]> {
  const r = await rows<{ name: string; nonUnique: number; method: string; cols: string }>(
    pool,
    `SELECT INDEX_NAME AS name, MIN(NON_UNIQUE) AS nonUnique, MIN(INDEX_TYPE) AS method, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS cols
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME`,
    [database, table],
  );
  return r.map((i) => ({ name: i.name, unique: !i.nonUnique, primary: i.name === "PRIMARY", method: i.method, columns: i.cols.split(",") }));
}

export interface ForeignKeyRow {
  name: string;
  columns: string[];
  refDatabase: string;
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export async function listForeignKeys(pool: mysql.Pool, database: string, table: string): Promise<ForeignKeyRow[]> {
  const r = await rows<{ name: string; cols: string; refDb: string; refTable: string; refCols: string; del: string; upd: string }>(
    pool,
    `SELECT k.CONSTRAINT_NAME AS name, GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS cols, k.REFERENCED_TABLE_SCHEMA AS refDb, k.REFERENCED_TABLE_NAME AS refTable,
            GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS refCols, MIN(r.DELETE_RULE) AS del, MIN(r.UPDATE_RULE) AS upd
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
      WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
      GROUP BY k.CONSTRAINT_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME ORDER BY k.CONSTRAINT_NAME`,
    [database, table],
  );
  return r.map((f) => ({ name: f.name, columns: f.cols.split(","), refDatabase: f.refDb, refTable: f.refTable, refColumns: f.refCols.split(","), onDelete: f.del, onUpdate: f.upd }));
}

/** `SHOW CREATE …` for a table, view or routine; the statement is the second (tables / views) or third (routines) column. */
export async function objectDefinition(pool: mysql.Pool, kind: ObjectKind, database: string, name: string): Promise<string | null> {
  const what = { tables: "TABLE", views: "VIEW", procedures: "PROCEDURE", functions: "FUNCTION" }[kind];
  const [r] = (await pool.query(`SHOW CREATE ${what} ${qualified(database, name)}`)) as unknown as [Array<Record<string, string | null>>];
  const row = r[0];
  if (!row) return null;
  return row[`Create ${what[0]}${what.slice(1).toLowerCase()}`] ?? null;
}

export interface Parameter {
  name: string;
  type: string;
  mode: "IN" | "OUT" | "INOUT";
}

/** Parameters of a procedure or function, in order (a function's return value, position 0, is left out). */
export async function listParameters(pool: mysql.Pool, database: string, name: string): Promise<Parameter[]> {
  const r = await rows<{ name: string | null; type: string; mode: string | null }>(
    pool,
    `SELECT PARAMETER_NAME AS name, DTD_IDENTIFIER AS type, PARAMETER_MODE AS mode FROM information_schema.PARAMETERS
      WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ORDINAL_POSITION > 0 ORDER BY ORDINAL_POSITION`,
    [database, name],
  );
  return r.map((p, i) => ({ name: p.name ?? `p${i + 1}`, type: p.type, mode: (p.mode as Parameter["mode"] | null) ?? "IN" }));
}

export interface CompletionCatalog {
  database: string;
  /** Every database: `db.` completes that database's objects. */
  schemas: string[];
  /** The window's current database — unqualified names resolve against it. */
  searchPath: string[];
  objects: Array<{ schema: string; name: string; kind: "table" | "view" | "procedure" | "function" }>;
  columns: Array<{ schema: string; object: string; name: string; type: string }>;
  truncated: boolean;
}

const MAX_CATALOG_COLUMNS = 50_000;

/** Everything the query editor's IntelliSense needs for one database. */
export async function completionCatalog(pool: mysql.Pool, database: string | undefined): Promise<CompletionCatalog> {
  const db = database ?? (await rows<{ db: string | null }>(pool, "SELECT DATABASE() AS db"))[0]?.db ?? "";
  const [dbs, tables, routines, columns] = await Promise.all([
    rows<{ name: string }>(pool, `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN (${SYSTEM_LIST}) ORDER BY 1`),
    rows<{ name: string; type: string }>(pool, "SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [db]),
    rows<{ name: string; type: string }>(pool, "SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?", [db]),
    rows<{ object: string; name: string; type: string }>(pool, `SELECT TABLE_NAME AS object, COLUMN_NAME AS name, COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT ${MAX_CATALOG_COLUMNS + 1}`, [db]),
  ]);
  return {
    database: db,
    schemas: dbs.map((d) => d.name),
    searchPath: db ? [db] : [],
    objects: [
      ...tables.map((t) => ({ schema: db, name: t.name, kind: (t.type === "VIEW" ? "view" : "table") as "table" | "view" })),
      ...routines.map((r) => ({ schema: db, name: r.name, kind: (r.type === "PROCEDURE" ? "procedure" : "function") as "procedure" | "function" })),
    ],
    columns: columns.slice(0, MAX_CATALOG_COLUMNS).map((c) => ({ schema: db, ...c })),
    truncated: columns.length > MAX_CATALOG_COLUMNS,
  };
}

export { quoteIdent, qualified };
