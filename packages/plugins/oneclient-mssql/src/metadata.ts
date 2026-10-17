import sql from "mssql";
import { quoteIdent } from "./config.js";

export interface DatabaseRow {
  name: string;
  database_id: number;
  state_desc: string;
}
export interface ObjectRow {
  schema: string;
  name: string;
}
export interface ColumnRow {
  name: string;
  type: string;
  max_length: number;
  precision: number;
  scale: number;
  is_nullable: boolean;
  is_identity: boolean;
  is_computed: boolean;
  is_pk: boolean;
  is_fk: boolean;
  default_definition: string | null;
}
export interface IndexRow {
  name: string;
  type_desc: string;
  is_unique: boolean;
  is_primary_key: boolean;
}
export interface ParameterRow {
  name: string;
  type: string;
  max_length: number;
  precision: number;
  scale: number;
  is_output: boolean;
}

/** `[db].[schema].[name]` — what OBJECT_ID() and FROM clauses take. */
export function qualified(database: string, schema: string, name: string): string {
  return `${quoteIdent(database)}.${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export async function listDatabases(pool: sql.ConnectionPool): Promise<DatabaseRow[]> {
  const r = await pool.request().query<DatabaseRow>("SELECT name, database_id, state_desc FROM sys.databases ORDER BY name");
  return r.recordset;
}

/** User objects of one kind in a database, schema-qualified, sorted like SSMS. */
export async function listObjects(
  pool: sql.ConnectionPool,
  database: string,
  kind: "tables" | "views" | "procedures" | "functions",
): Promise<ObjectRow[]> {
  const db = quoteIdent(database);
  const source = {
    tables: `${db}.sys.tables`,
    views: `${db}.sys.views`,
    procedures: `${db}.sys.procedures`,
    functions: `(SELECT * FROM ${db}.sys.objects WHERE type IN ('FN','IF','TF','FS','FT'))`,
  }[kind];
  const r = await pool
    .request()
    .query<ObjectRow>(
      `SELECT s.name AS [schema], o.name FROM ${source} o JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id WHERE o.is_ms_shipped = 0 ORDER BY s.name, o.name`,
    );
  return r.recordset;
}

export async function listColumns(pool: sql.ConnectionPool, database: string, schema: string, name: string): Promise<ColumnRow[]> {
  const db = quoteIdent(database);
  const r = await pool
    .request()
    .input("object", sql.NVarChar, qualified(database, schema, name))
    .query<ColumnRow>(`
      SELECT c.name, ty.name AS type, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed,
        CAST(CASE WHEN EXISTS (
          SELECT 1 FROM ${db}.sys.index_columns ic
          JOIN ${db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id
        ) THEN 1 ELSE 0 END AS bit) AS is_pk,
        CAST(CASE WHEN EXISTS (
          SELECT 1 FROM ${db}.sys.foreign_key_columns fk WHERE fk.parent_object_id = c.object_id AND fk.parent_column_id = c.column_id
        ) THEN 1 ELSE 0 END AS bit) AS is_fk,
        dc.definition AS default_definition
      FROM ${db}.sys.columns c
      JOIN ${db}.sys.types ty ON ty.user_type_id = c.user_type_id
      LEFT JOIN ${db}.sys.default_constraints dc ON dc.object_id = c.default_object_id
      WHERE c.object_id = OBJECT_ID(@object)
      ORDER BY c.column_id`);
  return r.recordset;
}

export async function listIndexes(pool: sql.ConnectionPool, database: string, schema: string, name: string): Promise<IndexRow[]> {
  const r = await pool
    .request()
    .input("object", sql.NVarChar, qualified(database, schema, name))
    .query<IndexRow>(
      `SELECT name, type_desc, is_unique, is_primary_key FROM ${quoteIdent(database)}.sys.indexes WHERE object_id = OBJECT_ID(@object) AND type > 0 ORDER BY is_primary_key DESC, name`,
    );
  return r.recordset;
}

export async function listParameters(pool: sql.ConnectionPool, database: string, schema: string, name: string): Promise<ParameterRow[]> {
  const db = quoteIdent(database);
  const r = await pool
    .request()
    .input("object", sql.NVarChar, qualified(database, schema, name))
    .query<ParameterRow>(`
      SELECT p.name, ty.name AS type, p.max_length, p.precision, p.scale, p.is_output
      FROM ${db}.sys.parameters p JOIN ${db}.sys.types ty ON ty.user_type_id = p.user_type_id
      WHERE p.object_id = OBJECT_ID(@object) AND p.parameter_id > 0
      ORDER BY p.parameter_id`);
  return r.recordset;
}

export async function objectDefinition(pool: sql.ConnectionPool, database: string, schema: string, name: string): Promise<string | null> {
  // OBJECT_DEFINITION resolves ids in the *current* database, so run it inside the target one
  // ([db].sys.sp_executesql executes in that database's context).
  const r = await pool
    .request()
    .input("object", sql.NVarChar, `${quoteIdent(schema)}.${quoteIdent(name)}`)
    .query<{ definition: string | null }>(
      `EXEC ${quoteIdent(database)}.sys.sp_executesql N'SELECT OBJECT_DEFINITION(OBJECT_ID(@o)) AS definition', N'@o nvarchar(max)', @o = @object`,
    );
  return r.recordset[0]?.definition ?? null;
}

export interface CompletionCatalog {
  database: string;
  schemas: string[];
  objects: Array<{ schema: string; name: string; kind: "table" | "view" | "procedure" | "function" }>;
  columns: Array<{ schema: string; object: string; name: string; type: string }>;
  /** True when the column list was cut off at MAX_CATALOG_COLUMNS. */
  truncated: boolean;
}

const MAX_CATALOG_COLUMNS = 50_000;

/**
 * Everything the query editor's IntelliSense needs for one database, in one
 * round trip. `database` omitted = the connection's default database.
 */
export async function completionCatalog(pool: sql.ConnectionPool, database?: string): Promise<CompletionCatalog> {
  const dbName =
    database ?? (await pool.request().query<{ db: string }>("SELECT DB_NAME() AS db")).recordset[0]?.db ?? "master";
  const db = quoteIdent(dbName);
  const result = await pool.request().query(`
    SELECT name FROM ${db}.sys.schemas WHERE schema_id < 16384 ORDER BY name;
    SELECT s.name AS [schema], o.name, RTRIM(o.type) AS type
      FROM ${db}.sys.objects o JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN ('U','V','P','FN','IF','TF') AND o.is_ms_shipped = 0;
    SELECT TOP (${MAX_CATALOG_COLUMNS + 1}) s.name AS [schema], o.name AS object, c.name, ty.name AS type, c.max_length, c.precision, c.scale
      FROM ${db}.sys.columns c
      JOIN ${db}.sys.objects o ON o.object_id = c.object_id
      JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
      JOIN ${db}.sys.types ty ON ty.user_type_id = c.user_type_id
      WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0
      ORDER BY o.object_id, c.column_id;`);
  const [schemas, objects, columns] = result.recordsets as unknown as [
    Array<{ name: string }>,
    Array<{ schema: string; name: string; type: string }>,
    Array<{ schema: string; object: string; name: string; type: string; max_length: number; precision: number; scale: number }>,
  ];
  const kinds: Record<string, CompletionCatalog["objects"][number]["kind"]> = {
    U: "table",
    V: "view",
    P: "procedure",
    FN: "function",
    IF: "function",
    TF: "function",
  };
  return {
    database: dbName,
    schemas: schemas.map((s) => s.name),
    objects: objects.map((o) => ({ schema: o.schema, name: o.name, kind: kinds[o.type] ?? "table" })),
    columns: columns
      .slice(0, MAX_CATALOG_COLUMNS)
      .map((c) => ({ schema: c.schema, object: c.object, name: c.name, type: formatType(c) })),
    truncated: columns.length > MAX_CATALOG_COLUMNS,
  };
}

/** SSMS-style type text: `nvarchar(50)`, `varchar(max)`, `decimal(18,2)`, `datetime2(7)`. */
export function formatType(t: { type: string; max_length: number; precision: number; scale: number }): string {
  const type = t.type.toLowerCase();
  if (["varchar", "char", "varbinary", "binary"].includes(type)) {
    return `${type}(${t.max_length === -1 ? "max" : t.max_length})`;
  }
  if (["nvarchar", "nchar"].includes(type)) {
    return `${type}(${t.max_length === -1 ? "max" : t.max_length / 2})`;
  }
  if (["decimal", "numeric"].includes(type)) return `${type}(${t.precision},${t.scale})`;
  if (["datetime2", "time", "datetimeoffset"].includes(type)) return `${type}(${t.scale})`;
  return type;
}
