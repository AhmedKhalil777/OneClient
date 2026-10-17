import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import { formatType, listColumns, listDatabases, listIndexes, listObjects } from "./metadata.js";
import { fakerSectionNodes } from "./faker/api.js";
import { requireSession } from "./sessions.js";

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

/** Database-scoped nodes carry the database; object-scoped ones also carry schema + name. */
export interface NodeData {
  database?: string;
  /** A faker file (FAKERS section), relative to the attached folder. */
  fakerFile?: string;
  schema?: string;
  name?: string;
}

const SYSTEM_DATABASE_IDS = new Set([1, 2, 3, 4]); // master, tempdb, model, msdb

function folder(id: string, label: string, nodeType: string, data: NodeData): TreeNode {
  return { id, label, nodeType, collapsible: "collapsed", icon: ICON.folder, contextValue: nodeType, data };
}

/** Mirrors SSMS's Object Explorer, minus the server-level folders that need sysadmin to be useful. */
export function createExplorerProvider(): ExplorerProvider {
  return {
    nodeTypes: [
      "mssql.databases",
      "mssql.systemDatabases",
      "mssql.database",
      "mssql.tables",
      "mssql.table",
      "mssql.views",
      "mssql.view",
      "mssql.columns",
      "mssql.column",
      "mssql.indexes",
      "mssql.index",
      "mssql.programmability",
      "mssql.procedures",
      "mssql.procedure",
      "mssql.functions",
      "mssql.function",
      "mssql.fakersRoot",
      "mssql.fakerGroup",
    ],

    async getChildren(node, ctx): Promise<TreeNode[]> {
      if (node && (node.nodeType === "mssql.fakersRoot" || node.nodeType === "mssql.fakerGroup")) return fakerSectionNodes(ctx.connectionId, node);
      const { pool } = requireSession(ctx.connectionId);
      if (!node) return [{ ...folder("databases", "Databases", "mssql.databases", {}), collapsible: "expanded" }];

      const data = (node.data ?? {}) as NodeData;
      const db = data.database ?? "";

      switch (node.nodeType) {
        case "mssql.databases":
        case "mssql.systemDatabases": {
          const system = node.nodeType === "mssql.systemDatabases";
          const dbs = (await listDatabases(pool)).filter((d) => SYSTEM_DATABASE_IDS.has(d.database_id) === system);
          const nodes = dbs.map((d): TreeNode => {
            const online = d.state_desc === "ONLINE";
            return {
              id: `db:${d.name}`,
              label: online ? d.name : `${d.name} (${d.state_desc})`,
              nodeType: "mssql.database",
              collapsible: online ? "collapsed" : "none",
              icon: ICON.database,
              contextValue: "mssql.database",
              data: { database: d.name } satisfies NodeData,
            };
          });
          return system ? nodes : [folder("system", "System Databases", "mssql.systemDatabases", {}), ...nodes];
        }

        case "mssql.database":
          return [
            folder(`${db}:tables`, "Tables", "mssql.tables", { database: db }),
            folder(`${db}:views`, "Views", "mssql.views", { database: db }),
            folder(`${db}:programmability`, "Programmability", "mssql.programmability", { database: db }),
          ];

        case "mssql.fakersRoot":
        case "mssql.fakerGroup":
          return fakerSectionNodes(ctx.connectionId, node);

        case "mssql.programmability":
          return [
            folder(`${db}:procedures`, "Stored Procedures", "mssql.procedures", { database: db }),
            folder(`${db}:functions`, "Functions", "mssql.functions", { database: db }),
          ];

        case "mssql.tables":
        case "mssql.views":
        case "mssql.procedures":
        case "mssql.functions": {
          const kind = node.nodeType.slice("mssql.".length) as "tables" | "views" | "procedures" | "functions";
          const childType = { tables: "mssql.table", views: "mssql.view", procedures: "mssql.procedure", functions: "mssql.function" }[kind];
          const icon = { tables: ICON.table, views: ICON.view, procedures: ICON.procedure, functions: ICON.function }[kind];
          const rows = await listObjects(pool, db, kind);
          return rows.map((o) => ({
            id: `${db}:${o.schema}.${o.name}`,
            label: `${o.schema}.${o.name}`,
            nodeType: childType,
            collapsible: kind === "tables" || kind === "views" ? "collapsed" : "none",
            icon,
            contextValue: childType,
            data: { database: db, schema: o.schema, name: o.name } satisfies NodeData,
          }));
        }

        case "mssql.table":
        case "mssql.view": {
          const base = `${db}:${data.schema}.${data.name}`;
          const children = [folder(`${base}:columns`, "Columns", "mssql.columns", data)];
          if (node.nodeType === "mssql.table") children.push(folder(`${base}:indexes`, "Indexes", "mssql.indexes", data));
          return children;
        }

        case "mssql.columns": {
          const cols = await listColumns(pool, db, data.schema ?? "", data.name ?? "");
          return cols.map((c) => {
            // SSMS: "Id (PK, int, not null)", "CustomerId (FK, int, null)"
            const tags = [c.is_pk ? "PK" : null, c.is_fk ? "FK" : null, c.is_computed ? "Computed" : formatType(c), c.is_nullable ? "null" : "not null"];
            return {
              id: `col:${c.name}`,
              label: `${c.name} (${tags.filter(Boolean).join(", ")})`,
              nodeType: "mssql.column",
              collapsible: "none" as const,
              icon: c.is_pk || c.is_fk ? ICON.key : ICON.column,
              contextValue: "mssql.column",
            };
          });
        }

        case "mssql.indexes": {
          const indexes = await listIndexes(pool, db, data.schema ?? "", data.name ?? "");
          return indexes.map((i) => {
            const kind = i.type_desc.replace(/_/g, "-").toLowerCase().replace(/(^|-)\w/g, (m) => m.toUpperCase());
            const tags = [i.is_unique && !i.is_primary_key ? "Unique" : null, kind];
            return {
              id: `idx:${i.name}`,
              label: `${i.name} (${tags.filter(Boolean).join(", ")})`,
              nodeType: "mssql.index",
              collapsible: "none" as const,
              icon: i.is_primary_key ? ICON.key : ICON.index,
              contextValue: "mssql.index",
            };
          });
        }

        default:
          return [];
      }
    },
  };
}
