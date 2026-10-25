import type mysql from "mysql2/promise";

/**
 * The ER-diagram model of a database — the shape @oneclient/editor-kit/erd draws. Declared here as a plain JSON
 * contract (the view receives it through invokeCommand), so the backend doesn't depend on the UI kit.
 */
export interface ErModel {
  database: string;
  tables: Array<{ id: string; schema: string; name: string; kind: "table" | "view"; columns: Array<{ name: string; type: string; nullable: boolean; pk: boolean; fk: boolean }>; comment?: string }>;
  relations: Array<{ id: string; name: string; from: string; fromColumns: string[]; to: string; toColumns: string[]; onDelete?: string }>;
  truncated?: boolean;
}

/** Diagrams beyond this many tables stop being readable (and slow to lay out). */
export const MAX_DIAGRAM_TABLES = 500;

async function rows<T>(pool: mysql.Pool, sql: string, params: unknown[]): Promise<T[]> {
  const [r] = (await pool.query(sql, params)) as unknown as [T[]];
  return r;
}

/** Tables, columns, primary and foreign keys of one database (references into other databases are left out). */
export async function erModel(pool: mysql.Pool, database: string): Promise<ErModel> {
  const tables = await rows<{ name: string; comment: string }>(
    pool,
    `SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME LIMIT ${MAX_DIAGRAM_TABLES + 1}`,
    [database],
  );
  const truncated = tables.length > MAX_DIAGRAM_TABLES;
  const kept = new Set(tables.slice(0, MAX_DIAGRAM_TABLES).map((t) => t.name));

  const [columns, fks] = await Promise.all([
    rows<{ table: string; name: string; type: string; nullable: number; key: string }>(
      pool,
      `SELECT TABLE_NAME AS \`table\`, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_KEY AS \`key\`
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [database],
    ),
    rows<{ name: string; table: string; col: string; refTable: string; refCol: string; del: string }>(
      pool,
      `SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS \`table\`, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol, r.DELETE_RULE AS del
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_SCHEMA = ? ORDER BY k.CONSTRAINT_NAME, k.TABLE_NAME, k.ORDINAL_POSITION`,
      [database, database],
    ),
  ]);

  const fkCols = new Set(fks.map((f) => `${f.table}:${f.col}`));
  const columnsOf = new Map<string, ErModel["tables"][number]["columns"]>();
  for (const c of columns) {
    if (!kept.has(c.table)) continue;
    const list = columnsOf.get(c.table) ?? [];
    list.push({ name: c.name, type: c.type, nullable: !!c.nullable, pk: c.key === "PRI", fk: fkCols.has(`${c.table}:${c.name}`) });
    columnsOf.set(c.table, list);
  }

  const relations = new Map<string, ErModel["relations"][number]>();
  for (const f of fks) {
    if (!kept.has(f.table) || !kept.has(f.refTable)) continue;
    const key = `${f.table}:${f.name}`;
    const rel = relations.get(key) ?? { id: key, name: f.name, from: `${database}.${f.table}`, fromColumns: [], to: `${database}.${f.refTable}`, toColumns: [], ...(f.del && f.del !== "NO ACTION" ? { onDelete: f.del } : {}) };
    rel.fromColumns.push(f.col);
    rel.toColumns.push(f.refCol);
    relations.set(key, rel);
  }

  return {
    database,
    tables: tables.filter((t) => kept.has(t.name)).map((t) => ({ id: `${database}.${t.name}`, schema: database, name: t.name, kind: "table", columns: columnsOf.get(t.name) ?? [], ...(t.comment ? { comment: t.comment } : {}) })),
    relations: [...relations.values()],
    ...(truncated ? { truncated: true } : {}),
  };
}
