import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import type { FastToolsSection } from "@oneclient/sql-core";
import { type ObjectKind, listColumns, listDatabases, listForeignKeys, listIndexes, listObjects } from "./metadata.js";
import { poolFor, requireSession } from "./sessions.js";

/** Registry icons (core's built-in set) — they follow the user's icon theme. */
const ICON = {
  folder: "$(folder)",
  database: "$(database)",
  table: "$(table)",
  view: "$(view)",
  procedure: "$(procedure)",
  function: "$(function)",
  column: "$(column)",
  key: "$(key)",
  index: "$(index)",
};

/**
 * Database-scoped nodes carry the database; object nodes also carry the name. MySQL has no schemas inside a database
 * (a database *is* the schema), so `schema` repeats the database for the table editor and CSV import, which address
 * tables as database / schema / table.
 */
export interface NodeData {
  database?: string;
  schema?: string;
  name?: string;
  kind?: ObjectKind;
  /** A fast query file (FAST TOOLS section), relative to the attached folder. */
  fastQueryFile?: string;
}

export const NODE_TYPES = [
  "mysql.databases",
  "mysql.systemDatabases",
  "mysql.database",
  "mysql.tables",
  "mysql.table",
  "mysql.views",
  "mysql.view",
  "mysql.procedures",
  "mysql.procedure",
  "mysql.functions",
  "mysql.function",
  "mysql.columns",
  "mysql.column",
  "mysql.indexes",
  "mysql.index",
  "mysql.foreignKeys",
  "mysql.foreignKey",
];

const FOLDERS: Array<{ kind: ObjectKind; label: string; child: string; icon: string; expandable: boolean }> = [
  { kind: "tables", label: "Tables", child: "mysql.table", icon: ICON.table, expandable: true },
  { kind: "views", label: "Views", child: "mysql.view", icon: ICON.view, expandable: true },
  { kind: "procedures", label: "Stored Procedures", child: "mysql.procedure", icon: ICON.procedure, expandable: false },
  { kind: "functions", label: "Functions", child: "mysql.function", icon: ICON.function, expandable: false },
];

function folder(id: string, label: string, nodeType: string, data: NodeData): TreeNode {
  return { id, label, nodeType, collapsible: "collapsed", icon: ICON.folder, contextValue: nodeType, data };
}

export function createExplorerProvider(fastTools: FastToolsSection | undefined): ExplorerProvider {
  return {
    nodeTypes: [...NODE_TYPES, ...(fastTools?.nodeTypes ?? [])],

    async getChildren(node, ctx): Promise<TreeNode[]> {
      // FAST TOOLS section (SQL core): works off the attached folder, so it doesn't need the server.
      if (node && fastTools?.handles(node.nodeType)) return fastTools.nodes(ctx.connectionId, node);
      const session = requireSession(ctx.connectionId);
      const showSystem = session.config.showSystemObjects === true;
      if (!node) return [{ ...folder("databases", "Databases", "mysql.databases", {}), collapsible: "expanded" }];

      const data = (node.data ?? {}) as NodeData;
      const db = data.database ?? "";
      const pool = poolFor(ctx.connectionId);

      switch (node.nodeType) {
        case "mysql.databases":
        case "mysql.systemDatabases": {
          const system = node.nodeType === "mysql.systemDatabases";
          const nodes = (await listDatabases(pool))
            .filter((d) => d.isSystem === system)
            .map(
              (d): TreeNode => ({
                id: `db:${d.name}`,
                label: d.name,
                nodeType: "mysql.database",
                collapsible: "collapsed",
                icon: ICON.database,
                contextValue: "mysql.database",
                data: { database: d.name } satisfies NodeData,
              }),
            );
          return !system && showSystem ? [folder("system", "System Databases", "mysql.systemDatabases", {}), ...nodes] : nodes;
        }

        case "mysql.database":
          return FOLDERS.map((f) => folder(`${db}:${f.kind}`, f.label, `mysql.${f.kind}`, { database: db }));

        case "mysql.tables":
        case "mysql.views":
        case "mysql.procedures":
        case "mysql.functions": {
          const f = FOLDERS.find((x) => `mysql.${x.kind}` === node.nodeType)!;
          return (await listObjects(pool, db, f.kind)).map((o) => ({
            id: `${db}.${o.name}:${f.kind}`,
            label: o.returns && f.kind === "functions" ? `${o.name} → ${o.returns}` : o.name,
            nodeType: f.child,
            collapsible: f.expandable ? "collapsed" : "none",
            icon: f.icon,
            contextValue: f.child,
            data: { database: db, schema: db, name: o.name, kind: f.kind } satisfies NodeData,
          }));
        }

        case "mysql.table":
        case "mysql.view": {
          const base = `${db}.${data.name}`;
          const children = [folder(`${base}:columns`, "Columns", "mysql.columns", data)];
          if (node.nodeType === "mysql.table") children.push(folder(`${base}:indexes`, "Indexes", "mysql.indexes", data), folder(`${base}:fks`, "Foreign Keys", "mysql.foreignKeys", data));
          return children;
        }

        case "mysql.columns":
          return (await listColumns(pool, db, data.name ?? "")).map((c) => {
            const tags = [c.isPk ? "PK" : null, c.isFk ? "FK" : null, c.type, c.autoIncrement ? "auto_increment" : c.generated ? "generated" : null, c.nullable ? "null" : "not null"];
            return {
              id: `col:${c.name}`,
              label: `${c.name} (${tags.filter(Boolean).join(", ")})`,
              nodeType: "mysql.column",
              collapsible: "none" as const,
              icon: c.isPk || c.isFk ? ICON.key : ICON.column,
              contextValue: "mysql.column",
            };
          });

        case "mysql.indexes":
          return (await listIndexes(pool, db, data.name ?? "")).map((i) => ({
            id: `idx:${i.name}`,
            label: `${i.name} (${[i.primary ? "Primary" : i.unique ? "Unique" : null, i.method, i.columns.join(", ")].filter(Boolean).join(", ")})`,
            nodeType: "mysql.index",
            collapsible: "none" as const,
            icon: i.primary ? ICON.key : ICON.index,
            contextValue: "mysql.index",
          }));

        case "mysql.foreignKeys":
          return (await listForeignKeys(pool, db, data.name ?? "")).map((k) => ({
            id: `fk:${k.name}`,
            label: `${k.name} (${k.columns.join(", ")} → ${k.refDatabase === db ? "" : `${k.refDatabase}.`}${k.refTable}(${k.refColumns.join(", ")}), on delete ${k.onDelete.toLowerCase()})`,
            nodeType: "mysql.foreignKey",
            collapsible: "none" as const,
            icon: ICON.key,
            contextValue: "mysql.foreignKey",
          }));

        default:
          return [];
      }
    },
  };
}
