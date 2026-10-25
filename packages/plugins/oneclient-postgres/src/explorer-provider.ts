import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import type { FastToolsSection } from "@oneclient/sql-core";
import { type ObjectKind, listColumns, listConstraints, listDatabases, listIndexes, listObjects, listSchemas } from "./metadata.js";
import { poolFor, requireSession } from "./sessions.js";

/** Registry icons (core's built-in set) — they follow the user's icon theme. */
const ICON = {
  folder: "$(folder)",
  database: "$(database)",
  schema: "$(folder)",
  table: "$(table)",
  view: "$(view)",
  procedure: "$(procedure)",
  function: "$(function)",
  column: "$(column)",
  key: "$(key)",
  index: "$(index)",
  sequence: "$(symbol-number)",
};

/** Database-scoped nodes carry the database; schema- and object-scoped ones also carry schema (+ name, args). */
export interface NodeData {
  database?: string;
  schema?: string;
  name?: string;
  /** Functions / procedures: argument types ("integer, text"), to address one overload. */
  sig?: string;
  kind?: ObjectKind;
}

export const NODE_TYPES = [
  "postgres.databases",
  "postgres.database",
  "postgres.schemas",
  "postgres.systemSchemas",
  "postgres.schema",
  "postgres.tables",
  "postgres.table",
  "postgres.views",
  "postgres.view",
  "postgres.matviews",
  "postgres.matview",
  "postgres.functions",
  "postgres.function",
  "postgres.procedures",
  "postgres.procedure",
  "postgres.sequences",
  "postgres.sequence",
  "postgres.columns",
  "postgres.column",
  "postgres.indexes",
  "postgres.index",
  "postgres.constraints",
  "postgres.constraint",
];

const FOLDERS: Array<{ kind: ObjectKind; label: string; child: string; icon: string; expandable: boolean }> = [
  { kind: "tables", label: "Tables", child: "postgres.table", icon: ICON.table, expandable: true },
  { kind: "views", label: "Views", child: "postgres.view", icon: ICON.view, expandable: true },
  { kind: "matviews", label: "Materialized Views", child: "postgres.matview", icon: ICON.view, expandable: true },
  { kind: "functions", label: "Functions", child: "postgres.function", icon: ICON.function, expandable: false },
  { kind: "procedures", label: "Procedures", child: "postgres.procedure", icon: ICON.procedure, expandable: false },
  { kind: "sequences", label: "Sequences", child: "postgres.sequence", icon: ICON.sequence, expandable: false },
];

function folder(id: string, label: string, nodeType: string, data: NodeData): TreeNode {
  return { id, label, nodeType, collapsible: "collapsed", icon: ICON.folder, contextValue: nodeType, data };
}

const CONSTRAINT_KIND: Record<string, string> = { p: "Primary key", u: "Unique", c: "Check", f: "Foreign key", x: "Exclusion", n: "Not null" };

/** Databases → schemas → tables / views / materialized views / functions / procedures / sequences — like pgAdmin. */
export function createExplorerProvider(fastTools: FastToolsSection | undefined): ExplorerProvider {
  return {
    nodeTypes: [...NODE_TYPES, ...(fastTools?.nodeTypes ?? [])],

    async getChildren(node, ctx): Promise<TreeNode[]> {
      // FAST TOOLS section (SQL core): works off the attached folder, so it doesn't need the server.
      if (node && fastTools?.handles(node.nodeType)) return fastTools.nodes(ctx.connectionId, node);
      const session = requireSession(ctx.connectionId);
      const showSystem = session.config.showSystemObjects === true;
      if (!node) return [{ ...folder("databases", "Databases", "postgres.databases", {}), collapsible: "expanded" }];

      const data = (node.data ?? {}) as NodeData;
      const db = data.database ?? "";
      const pool = () => poolFor(ctx.connectionId, db || undefined);

      switch (node.nodeType) {
        case "postgres.databases":
          return (await listDatabases(poolFor(ctx.connectionId)))
            .filter((d) => showSystem || !d.isTemplate)
            .map(
              (d): TreeNode => ({
                id: `db:${d.name}`,
                label: d.allowConn ? d.name : `${d.name} (connections not allowed)`,
                nodeType: "postgres.database",
                collapsible: d.allowConn ? "collapsed" : "none",
                icon: ICON.database,
                contextValue: "postgres.database",
                data: { database: d.name } satisfies NodeData,
              }),
            );

        case "postgres.database":
          return [{ ...folder(`${db}:schemas`, "Schemas", "postgres.schemas", { database: db }), collapsible: "expanded" }];

        case "postgres.schemas":
        case "postgres.systemSchemas": {
          const system = node.nodeType === "postgres.systemSchemas";
          const nodes = (await listSchemas(pool(), system)).map(
            (s): TreeNode => ({
              id: `${db}:schema:${s}`,
              label: s,
              nodeType: "postgres.schema",
              collapsible: "collapsed",
              icon: ICON.schema,
              contextValue: "postgres.schema",
              data: { database: db, schema: s } satisfies NodeData,
            }),
          );
          return !system && showSystem ? [folder(`${db}:system`, "System Schemas", "postgres.systemSchemas", { database: db }), ...nodes] : nodes;
        }

        case "postgres.schema":
          return FOLDERS.map((f) => folder(`${db}:${data.schema}:${f.kind}`, f.label, `postgres.${f.kind}`, { database: db, schema: data.schema ?? "" }));

        case "postgres.tables":
        case "postgres.views":
        case "postgres.matviews":
        case "postgres.functions":
        case "postgres.procedures":
        case "postgres.sequences": {
          const f = FOLDERS.find((x) => `postgres.${x.kind}` === node.nodeType)!;
          const rows = await listObjects(pool(), data.schema ?? "", f.kind);
          return rows.map((o) => ({
            id: `${db}:${o.schema}.${o.name}(${o.args ?? ""})`,
            label: o.args !== undefined ? `${o.name}(${o.args})${o.returns && f.kind === "functions" ? ` → ${o.returns}` : ""}` : o.name,
            nodeType: f.child,
            collapsible: f.expandable ? "collapsed" : "none",
            icon: f.icon,
            contextValue: f.child,
            data: { database: db, schema: o.schema, name: o.name, kind: f.kind, ...(o.sig !== undefined ? { sig: o.sig } : {}) } satisfies NodeData,
          }));
        }

        case "postgres.table":
        case "postgres.view":
        case "postgres.matview": {
          const base = `${db}:${data.schema}.${data.name}`;
          const children = [folder(`${base}:columns`, "Columns", "postgres.columns", data)];
          if (node.nodeType !== "postgres.view") children.push(folder(`${base}:indexes`, "Indexes", "postgres.indexes", data));
          if (node.nodeType === "postgres.table") children.push(folder(`${base}:constraints`, "Constraints", "postgres.constraints", data));
          return children;
        }

        case "postgres.columns":
          return (await listColumns(pool(), data.schema ?? "", data.name ?? "")).map((c) => {
            const tags = [c.isPk ? "PK" : null, c.isFk ? "FK" : null, c.type, c.identity ? "identity" : c.generated ? "generated" : null, c.nullable ? "null" : "not null"];
            return {
              id: `col:${c.name}`,
              label: `${c.name} (${tags.filter(Boolean).join(", ")})`,
              nodeType: "postgres.column",
              collapsible: "none" as const,
              icon: c.isPk || c.isFk ? ICON.key : ICON.column,
              contextValue: "postgres.column",
            };
          });

        case "postgres.indexes":
          return (await listIndexes(pool(), data.schema ?? "", data.name ?? "")).map((i) => ({
            id: `idx:${i.name}`,
            label: `${i.name} (${[i.isPrimary ? "Primary" : i.isUnique ? "Unique" : null, i.method].filter(Boolean).join(", ")})`,
            nodeType: "postgres.index",
            collapsible: "none" as const,
            icon: i.isPrimary ? ICON.key : ICON.index,
            contextValue: "postgres.index",
          }));

        case "postgres.constraints":
          return (await listConstraints(pool(), data.schema ?? "", data.name ?? ""))
            .filter((k) => k.type !== "n")
            .map((k) => ({
              id: `con:${k.name}`,
              label: `${k.name} (${CONSTRAINT_KIND[k.type] ?? k.type}: ${k.definition.length > 80 ? `${k.definition.slice(0, 80)}…` : k.definition})`,
              nodeType: "postgres.constraint",
              collapsible: "none" as const,
              icon: k.type === "p" || k.type === "f" ? ICON.key : ICON.index,
              contextValue: "postgres.constraint",
            }));

        default:
          return [];
      }
    },
  };
}
