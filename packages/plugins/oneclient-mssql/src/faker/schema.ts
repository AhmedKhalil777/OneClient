import sql from "mssql";
import { quoteIdent } from "../config.js";
import { qualified } from "../metadata.js";

export interface ForeignKeyRef {
  constraint: string;
  schema: string;
  table: string;
  column: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  maxLength: number;
  precision: number;
  scale: number;
  nullable: boolean;
  identity: boolean;
  computed: boolean;
  primaryKey: boolean;
  /** Single-column unique index or constraint (or the only PK column) — generated values must not repeat. */
  unique: boolean;
  hasDefault: boolean;
  /** The column references another table (single-column foreign keys). */
  fk?: ForeignKeyRef;
  /** Current MAX() for a non-identity integer key, so a sequence can start after it. */
  maxValue?: number;
  /** The generator can't produce this type (geography, hierarchyid, rowversion…). */
  unsupported: boolean;
}

export interface TableInfo {
  database: string;
  schema: string;
  table: string;
  columns: ColumnInfo[];
  /** Tables whose single-column foreign keys point at this one — candidates for nested child rows. */
  referencedBy: Array<{ schema: string; table: string; column: string; references: string }>;
}

const UNSUPPORTED = new Set(["geography", "geometry", "hierarchyid", "sql_variant", "timestamp", "rowversion", "image", "xml"]);
const INTEGER = new Set(["int", "bigint", "smallint", "tinyint"]);

/** Columns of a table plus what the generator needs: keys, uniqueness, foreign keys, defaults. */
export async function tableInfo(pool: sql.ConnectionPool, database: string, schema: string, table: string): Promise<TableInfo> {
  const db = quoteIdent(database);
  const object = qualified(database, schema, table);
  const r = await pool
    .request()
    .input("object", sql.NVarChar, object)
    .query<{
      name: string;
      column_id: number;
      type: string;
      max_length: number;
      precision: number;
      scale: number;
      is_nullable: boolean;
      is_identity: boolean;
      is_computed: boolean;
      has_default: boolean;
      is_pk: boolean;
      pk_columns: number;
      is_unique: boolean;
    }>(`
      SELECT c.name, c.column_id, TYPE_NAME(c.system_type_id) AS type, c.max_length, c.precision, c.scale,
        c.is_nullable, c.is_identity, c.is_computed,
        CAST(CASE WHEN c.default_object_id <> 0 THEN 1 ELSE 0 END AS bit) AS has_default,
        CAST(CASE WHEN EXISTS (SELECT 1 FROM ${db}.sys.index_columns ic JOIN ${db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS bit) AS is_pk,
        (SELECT COUNT(*) FROM ${db}.sys.index_columns ic JOIN ${db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.is_included_column = 0) AS pk_columns,
        CAST(CASE WHEN EXISTS (SELECT 1 FROM ${db}.sys.index_columns ic JOIN ${db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          WHERE i.is_unique = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id AND ic.is_included_column = 0
            AND (SELECT COUNT(*) FROM ${db}.sys.index_columns x WHERE x.object_id = i.object_id AND x.index_id = i.index_id AND x.is_included_column = 0) = 1)
          THEN 1 ELSE 0 END AS bit) AS is_unique
      FROM ${db}.sys.columns c
      WHERE c.object_id = OBJECT_ID(@object)
      ORDER BY c.column_id`);
  if (r.recordset.length === 0) throw new Error(`Table ${schema}.${table} was not found in ${database}.`);

  const fks = await pool
    .request()
    .input("object", sql.NVarChar, object)
    .query<{ constraint_name: string; column_name: string; ref_schema: string; ref_table: string; ref_column: string; columns: number }>(`
      SELECT fk.name AS constraint_name, pc.name AS column_name, rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_column,
        (SELECT COUNT(*) FROM ${db}.sys.foreign_key_columns x WHERE x.constraint_object_id = fk.object_id) AS columns
      FROM ${db}.sys.foreign_keys fk
      JOIN ${db}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN ${db}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN ${db}.sys.tables rt ON rt.object_id = fkc.referenced_object_id
      JOIN ${db}.sys.schemas rs ON rs.schema_id = rt.schema_id
      JOIN ${db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE fk.parent_object_id = OBJECT_ID(@object)`);
  const fkByColumn = new Map<string, ForeignKeyRef>();
  for (const f of fks.recordset) {
    if (f.columns !== 1) continue; // composite foreign keys aren't mapped (the column falls back to its type's generator)
    fkByColumn.set(f.column_name, { constraint: f.constraint_name, schema: f.ref_schema, table: f.ref_table, column: f.ref_column });
  }

  const columns: ColumnInfo[] = r.recordset.map((c) => {
    const fk = fkByColumn.get(c.name);
    const isRowversion = c.type === "timestamp";
    return {
      name: c.name,
      type: c.type,
      maxLength: c.max_length,
      precision: c.precision,
      scale: c.scale,
      nullable: c.is_nullable,
      identity: c.is_identity,
      computed: c.is_computed || isRowversion,
      primaryKey: c.is_pk,
      unique: c.is_unique || (c.is_pk && c.pk_columns === 1),
      hasDefault: c.has_default,
      ...(fk ? { fk } : {}),
      unsupported: UNSUPPORTED.has(c.type),
    };
  });

  // Integer keys that aren't identity: remember where the data ends so a sequence can continue after it.
  for (const c of columns) {
    if (c.primaryKey && !c.identity && !c.fk && INTEGER.has(c.type)) {
      const m = await pool.request().query<{ m: number | null }>(`SELECT MAX(${quoteIdent(c.name)}) AS m FROM ${object}`);
      c.maxValue = Number(m.recordset[0]?.m ?? 0);
    }
  }
  const refs = await pool
    .request()
    .input("object", sql.NVarChar, object)
    .query<{ schema: string; table: string; column: string; references: string; columns: number }>(`
      SELECT cs.name AS [schema], ct.name AS [table], cc.name AS [column], rc.name AS [references],
        (SELECT COUNT(*) FROM ${db}.sys.foreign_key_columns x WHERE x.constraint_object_id = fkc.constraint_object_id) AS columns
      FROM ${db}.sys.foreign_key_columns fkc
      JOIN ${db}.sys.tables ct ON ct.object_id = fkc.parent_object_id
      JOIN ${db}.sys.schemas cs ON cs.schema_id = ct.schema_id
      JOIN ${db}.sys.columns cc ON cc.object_id = fkc.parent_object_id AND cc.column_id = fkc.parent_column_id
      JOIN ${db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE fkc.referenced_object_id = OBJECT_ID(@object) AND fkc.parent_object_id <> fkc.referenced_object_id
      ORDER BY cs.name, ct.name, cc.name`);
  const referencedBy = refs.recordset.filter((r) => r.columns === 1).map(({ schema: s, table: tb, column, references }) => ({ schema: s, table: tb, column, references }));
  return { database, schema, table, columns, referencedBy };
}
