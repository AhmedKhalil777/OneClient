import type pg from "pg";

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

const SYSTEM_SCHEMA = `(n.nspname IN ('pg_catalog','information_schema') OR n.nspname LIKE 'pg\\_toast%' OR n.nspname LIKE 'pg\\_temp\\_%')`;
const ON_DELETE: Record<string, string> = { r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

interface TableRow {
  oid: number;
  schema: string;
  name: string;
  comment: string | null;
}

async function tablesWhere(pool: pg.Pool, where: string, params: unknown[]): Promise<TableRow[]> {
  const r = await pool.query<TableRow>(
    `SELECT c.oid, n.nspname AS schema, c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','f') AND NOT c.relispartition AND ${where}
      ORDER BY n.nspname, c.relname
      LIMIT ${MAX_DIAGRAM_TABLES + 1}`,
    params,
  );
  return r.rows;
}

/**
 * Tables, columns, primary and foreign keys of the database the pool is connected to — every user schema, or just
 * `schema`. Tables in other schemas that a foreign key points to are included too, so no line dangles.
 */
export async function erModel(pool: pg.Pool, schema?: string): Promise<ErModel> {
  const [db, seed] = await Promise.all([
    pool.query<{ db: string }>("SELECT current_database() AS db"),
    schema ? tablesWhere(pool, "n.nspname = $1", [schema]) : tablesWhere(pool, `NOT ${SYSTEM_SCHEMA}`, []),
  ]);
  const truncated = seed.length > MAX_DIAGRAM_TABLES;
  const tables = seed.slice(0, MAX_DIAGRAM_TABLES);

  const fkRows = async (oids: number[]) =>
    (
      await pool.query<{ id: number; name: string; child: number; parent: number; del: string; col: string; refcol: string }>(
        `SELECT k.oid AS id, k.conname AS name, k.conrelid AS child, k.confrelid AS parent, k.confdeltype AS del, ca.attname AS col, pa.attname AS refcol
           FROM pg_constraint k
           CROSS JOIN LATERAL unnest(k.conkey, k.confkey) WITH ORDINALITY AS u(c, p, i)
           JOIN pg_attribute ca ON ca.attrelid = k.conrelid AND ca.attnum = u.c
           JOIN pg_attribute pa ON pa.attrelid = k.confrelid AND pa.attnum = u.p
          WHERE k.contype = 'f' AND k.conrelid = ANY($1::oid[])
          ORDER BY k.oid, u.i`,
        [oids],
      )
    ).rows;
  const fks = await fkRows(tables.map((t) => t.oid));

  // Referenced tables outside the selection (another schema): add them so their lines have an end.
  const have = new Set(tables.map((t) => t.oid));
  const missing = [...new Set(fks.map((f) => f.parent).filter((oid) => !have.has(oid)))];
  if (missing.length && tables.length < MAX_DIAGRAM_TABLES) {
    tables.push(...(await tablesWhere(pool, "c.oid = ANY($1::oid[])", [missing])).slice(0, MAX_DIAGRAM_TABLES - tables.length));
  }
  const oids = tables.map((t) => t.oid);

  const [columns, pks] = await Promise.all([
    pool.query<{ oid: number; name: string; type: string; nullable: boolean }>(
      `SELECT a.attrelid AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable
         FROM pg_attribute a
        WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attrelid, a.attnum`,
      [oids],
    ),
    pool.query<{ oid: number; name: string }>(
      `SELECT k.conrelid AS oid, a.attname AS name
         FROM pg_constraint k
         CROSS JOIN LATERAL unnest(k.conkey) AS u(n)
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n
        WHERE k.contype = 'p' AND k.conrelid = ANY($1::oid[])`,
      [oids],
    ),
  ]);

  const idOf = new Map(tables.map((t) => [t.oid, `${t.schema}.${t.name}`]));
  const pkSet = new Set(pks.rows.map((p) => `${p.oid}:${p.name}`));
  const fkSet = new Set(fks.map((f) => `${f.child}:${f.col}`));
  const columnsOf = new Map<number, ErModel["tables"][number]["columns"]>();
  for (const c of columns.rows) {
    const list = columnsOf.get(c.oid) ?? [];
    list.push({ name: c.name, type: c.type, nullable: c.nullable, pk: pkSet.has(`${c.oid}:${c.name}`), fk: fkSet.has(`${c.oid}:${c.name}`) });
    columnsOf.set(c.oid, list);
  }

  const relations = new Map<number, ErModel["relations"][number]>();
  for (const f of fks) {
    const from = idOf.get(f.child);
    const to = idOf.get(f.parent);
    if (!from || !to) continue;
    const rel = relations.get(f.id) ?? { id: String(f.id), name: f.name, from, fromColumns: [], to, toColumns: [], ...(ON_DELETE[f.del] ? { onDelete: ON_DELETE[f.del] } : {}) };
    rel.fromColumns.push(f.col);
    rel.toColumns.push(f.refcol);
    relations.set(f.id, rel);
  }

  return {
    database: db.rows[0]?.db ?? "",
    tables: tables.map((t) => ({ id: `${t.schema}.${t.name}`, schema: t.schema, name: t.name, kind: "table", columns: columnsOf.get(t.oid) ?? [], ...(t.comment ? { comment: t.comment } : {}) })),
    relations: [...relations.values()],
    ...(truncated ? { truncated: true } : {}),
  };
}
