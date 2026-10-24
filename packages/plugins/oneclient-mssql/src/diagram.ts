import type sql from "mssql";
import { quoteIdent } from "./config.js";
import { formatType } from "./metadata.js";

/**
 * The ER-diagram model of a database (or one schema) — the shape @oneclient/editor-kit/erd draws. Declared here as a
 * plain JSON contract (the view receives it through invokeCommand), so the backend doesn't depend on the UI kit.
 */
export interface ErModel {
  database: string;
  tables: Array<{ id: string; schema: string; name: string; kind: "table" | "view"; columns: Array<{ name: string; type: string; nullable: boolean; pk: boolean; fk: boolean }>; comment?: string }>;
  relations: Array<{ id: string; name: string; from: string; fromColumns: string[]; to: string; toColumns: string[]; onDelete?: string }>;
  truncated?: boolean;
}

/** Diagrams beyond this many tables stop being readable (and slow to lay out). */
export const MAX_DIAGRAM_TABLES = 500;

interface TableRow {
  id: number;
  schema: string;
  name: string;
  comment: string | null;
}

/**
 * Tables, columns, primary and foreign keys of one database — every schema, or just `schema`. Tables in other schemas
 * that a foreign key points to are included too, so no line dangles. Table descriptions come from MS_Description.
 */
export async function erModel(pool: sql.ConnectionPool, database: string, schema?: string): Promise<ErModel> {
  const db = quoteIdent(database);
  const tableQuery = (where: string) => `
    SELECT TOP (${MAX_DIAGRAM_TABLES + 1}) t.object_id AS id, s.name AS [schema], t.name,
           CAST(ep.value AS nvarchar(4000)) AS comment
      FROM ${db}.sys.tables t
      JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
      LEFT JOIN ${db}.sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description'
     WHERE t.is_ms_shipped = 0 AND ${where}
     ORDER BY s.name, t.name`;
  const req = pool.request();
  if (schema) req.input("schema", schema);
  const seed = (await req.query<TableRow>(tableQuery(schema ? "s.name = @schema" : "1 = 1"))).recordset;
  const truncated = seed.length > MAX_DIAGRAM_TABLES;
  const tables = seed.slice(0, MAX_DIAGRAM_TABLES);
  // object ids are integers from the catalog: safe to inline.
  const list = (ids: number[]) => (ids.length ? ids.map((id) => String(Math.trunc(id))).join(",") : "NULL");

  const fks = (
    await pool.request().query<{ id: number; name: string; child: number; parent: number; del: string; col: string; refcol: string }>(`
      SELECT fk.object_id AS id, fk.name, fk.parent_object_id AS child, fk.referenced_object_id AS parent,
             fk.delete_referential_action_desc AS del, pc.name AS col, rc.name AS refcol
        FROM ${db}.sys.foreign_keys fk
        JOIN ${db}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN ${db}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
        JOIN ${db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
       WHERE fk.parent_object_id IN (${list(tables.map((t) => t.id))})
       ORDER BY fk.object_id, fkc.constraint_column_id`)
  ).recordset;

  // Referenced tables outside the selection (another schema): add them so their lines have an end.
  const have = new Set(tables.map((t) => t.id));
  const missing = [...new Set(fks.map((f) => f.parent).filter((id) => !have.has(id)))];
  if (missing.length && tables.length < MAX_DIAGRAM_TABLES) {
    tables.push(...(await pool.request().query<TableRow>(tableQuery(`t.object_id IN (${list(missing)})`))).recordset.slice(0, MAX_DIAGRAM_TABLES - tables.length));
  }
  const ids = list(tables.map((t) => t.id));

  const [columns, pks] = await Promise.all([
    pool.request().query<{ id: number; name: string; type: string; max_length: number; precision: number; scale: number; is_nullable: boolean }>(`
      SELECT c.object_id AS id, c.name, ty.name AS type, c.max_length, c.precision, c.scale, c.is_nullable
        FROM ${db}.sys.columns c
        JOIN ${db}.sys.types ty ON ty.user_type_id = c.user_type_id
       WHERE c.object_id IN (${ids})
       ORDER BY c.object_id, c.column_id`),
    pool.request().query<{ id: number; name: string }>(`
      SELECT ic.object_id AS id, c.name
        FROM ${db}.sys.indexes i
        JOIN ${db}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN ${db}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.is_primary_key = 1 AND i.object_id IN (${ids})`),
  ]);

  const idOf = new Map(tables.map((t) => [t.id, `${t.schema}.${t.name}`]));
  const pkSet = new Set(pks.recordset.map((p) => `${p.id}:${p.name}`));
  const fkSet = new Set(fks.map((f) => `${f.child}:${f.col}`));
  const columnsOf = new Map<number, ErModel["tables"][number]["columns"]>();
  for (const c of columns.recordset) {
    const listFor = columnsOf.get(c.id) ?? [];
    listFor.push({ name: c.name, type: formatType(c), nullable: c.is_nullable, pk: pkSet.has(`${c.id}:${c.name}`), fk: fkSet.has(`${c.id}:${c.name}`) });
    columnsOf.set(c.id, listFor);
  }

  const relations = new Map<number, ErModel["relations"][number]>();
  for (const f of fks) {
    const from = idOf.get(f.child);
    const to = idOf.get(f.parent);
    if (!from || !to) continue;
    const onDelete = f.del && f.del !== "NO_ACTION" ? f.del.replace(/_/g, " ") : undefined;
    const rel = relations.get(f.id) ?? { id: String(f.id), name: f.name, from, fromColumns: [], to, toColumns: [], ...(onDelete ? { onDelete } : {}) };
    rel.fromColumns.push(f.col);
    rel.toColumns.push(f.refcol);
    relations.set(f.id, rel);
  }

  return {
    database,
    tables: tables.map((t) => ({ id: `${t.schema}.${t.name}`, schema: t.schema, name: t.name, kind: "table", columns: columnsOf.get(t.id) ?? [], ...(t.comment ? { comment: t.comment } : {}) })),
    relations: [...relations.values()],
    ...(truncated ? { truncated: true } : {}),
  };
}
