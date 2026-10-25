import type { CommandHandler, TreeNode } from "@oneclient/plugin-api";
import { type SqlCore, commandArg as arg } from "@oneclient/sql-core";
import { describeConnection, qualified, quoteIdent } from "./config.js";
import type { NodeData } from "./explorer-provider.js";
import { type ObjectKind, completionCatalog, listColumns, listDatabases, listParameters, objectDefinition, scriptTable } from "./metadata.js";
import { erModel } from "./diagram.js";
import { searchObjects } from "./search.js";
import { poolFor, requireSession } from "./sessions.js";

/** Context-menu args: core spreads the right-clicked node's `data` in (see CommandContribution.when). */
type NodeArg = { connectionId: string } & NodeData;

const isRoutine = (kind: ObjectKind | undefined) => kind === "functions" || kind === "procedures";

/** The ER diagram tab of a database or one schema; one tab per target, so opening it again focuses it. */
function diagramTab(database: string, schema?: string, focus?: string): TreeNode {
  const title = `Diagram: ${schema ? `${database}.${schema}` : database}`;
  const params: Record<string, string> = { database };
  if (schema) params.schema = schema;
  if (focus) params.focus = focus;
  return { id: `diagram:${database}:${schema ?? "*"}`, label: title, nodeType: "postgres.diagram", collapsible: "none", openView: { viewId: "postgres.diagram", title, icon: "$(diagram)", params } };
}

/** PostgreSQL's own commands; query execution, history and Fast Queries come from the SQL core (`core.commands`). */
export function createCommandHandlers(core: SqlCore): CommandHandler[] {
  const { action, queryWindow } = core;
  return [
    {
      // The diagram view's data: tables, columns, keys and relations.
      commandId: "postgres.erModel",
      execute: (args) => {
        const { connectionId, database, schema } = arg<{ connectionId: string; database?: string; schema?: string }>(args);
        return erModel(poolFor(connectionId, database), schema || undefined);
      },
    },
    {
      commandId: "postgres.diagram",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", schema, name, kind } = arg<NodeArg>(args);
          requireSession(connectionId);
          const db = database || (await poolFor(connectionId).query<{ db: string }>("SELECT current_database() AS db")).rows[0]!.db;
          // From a table: its schema, with that table selected.
          const focus = name && (kind === "tables" || !kind) && schema ? `${schema}.${name}` : undefined;
          return { ok: true, openNode: diagramTab(db, schema, focus) };
        }),
    },
    {
      // Global search provider (contributes.searchProviders).
      commandId: "postgres.search",
      execute: (args) => {
        const { connectionId, query, limit } = arg<{ connectionId: string; query: string; limit?: number }>(args);
        return searchObjects(connectionId, String(query ?? ""), Math.min(50, Math.max(1, limit ?? 20)));
      },
    },
    {
      commandId: "postgres.newQuery",
      execute: (args) =>
        action(async () => {
          const { connectionId, database, schema } = arg<NodeArg>(args);
          requireSession(connectionId);
          const sql = schema && schema !== "public" ? `SET search_path TO ${quoteIdent(schema)}, public;\n\n` : undefined;
          return { ok: true, openNode: queryWindow({ database, ...(sql ? { sql } : {}) }) };
        }),
    },
    {
      commandId: "postgres.selectTop",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", schema = "", name = "" } = arg<NodeArg>(args);
          const cols = await listColumns(poolFor(connectionId, database), schema, name);
          const list = cols.length ? cols.map((c) => quoteIdent(c.name)).join(",\n       ") : "*";
          const sql = `SELECT ${list}\n  FROM ${qualified(schema, name)}\n LIMIT 1000;`;
          return { ok: true, openNode: queryWindow({ database, sql, autorun: true, title: `${name}.sql` }) };
        }),
    },
    {
      commandId: "postgres.countRows",
      execute: (args) =>
        action(async () => {
          const { database = "", schema = "", name = "" } = arg<NodeArg>(args);
          const sql = `SELECT count(*) FROM ${qualified(schema, name)};`;
          return { ok: true, openNode: queryWindow({ database, sql, autorun: true }) };
        }),
    },
    {
      commandId: "postgres.scriptCreate",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", schema = "", name = "" } = arg<NodeArg>(args);
          const ddl = await scriptTable(poolFor(connectionId, database), schema, name);
          return { ok: true, openNode: queryWindow({ database, sql: `-- Table: ${schema}.${name}\n\n${ddl}`, title: `${name}.sql` }) };
        }),
    },
    {
      commandId: "postgres.scriptInsert",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", schema = "", name = "" } = arg<NodeArg>(args);
          const cols = (await listColumns(poolFor(connectionId, database), schema, name)).filter((c) => !c.generated && c.identity !== "a");
          const sql =
            `INSERT INTO ${qualified(schema, name)} (\n    ${cols.map((c) => quoteIdent(c.name)).join(",\n    ")}\n) VALUES (\n    ` +
            `${cols.map((c) => `NULL -- ${c.name} ${c.type}${c.default ? ` (default ${c.default})` : ""}`).join(",\n    ")}\n)\nRETURNING *;`;
          return { ok: true, openNode: queryWindow({ database, sql, title: `${name}-insert.sql` }) };
        }),
    },
    {
      commandId: "postgres.scriptModify",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", schema = "", name = "", kind = "views", sig = "" } = arg<NodeArg>(args);
          const definition = await objectDefinition(poolFor(connectionId, database), kind, schema, name, sig);
          if (definition === null) throw new Error(`Can't read the definition of ${schema}.${name}.`);
          return { ok: true, openNode: queryWindow({ database, sql: definition.trimEnd() + (definition.trimEnd().endsWith(";") ? "\n" : ";\n"), title: `${name}.sql` }) };
        }),
    },
    {
      commandId: "postgres.scriptExecute",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", schema = "", name = "", kind, sig = "" } = arg<NodeArg>(args);
          if (!isRoutine(kind)) throw new Error("Not a function or procedure.");
          const params = (await listParameters(poolFor(connectionId, database), schema, name, sig)).filter((p) => p.mode === "i" || p.mode === "b" || p.mode === "v" || (kind === "procedures" && p.mode === "o"));
          const values = params.map((p) => `${quoteIdent(p.name)} => NULL::${p.type}${p.mode === "o" ? " -- OUT" : ""}`);
          const call = `${qualified(schema, name)}(${values.length ? `\n    ${values.join(",\n    ")}\n` : ""})`;
          const sql = `-- TODO: set the parameter values.\n${kind === "procedures" ? `CALL ${call}` : `SELECT * FROM ${call}`};\n`;
          return { ok: true, openNode: queryWindow({ database, sql }) };
        }),
    },

    // ---- Used by the query window (view == 'postgres.query') ----
    {
      commandId: "postgres.listDatabases",
      async execute(args) {
        const { connectionId } = arg<{ connectionId: string }>(args);
        return (await listDatabases(poolFor(connectionId))).filter((d) => d.allowConn && !d.isTemplate).map((d) => d.name);
      },
    },
    {
      commandId: "postgres.completionCatalog",
      async execute(args) {
        const { connectionId, database } = arg<{ connectionId: string; database?: string }>(args);
        return completionCatalog(poolFor(connectionId, database || undefined));
      },
    },
    {
      commandId: "postgres.serverInfo",
      async execute(args) {
        const { connectionId } = arg<{ connectionId: string }>(args);
        const session = requireSession(connectionId);
        const r = await poolFor(connectionId).query<{ version: string }>("SELECT current_setting('server_version') AS version");
        return { ...describeConnection(session.config), version: `PostgreSQL ${r.rows[0]?.version ?? ""}` };
      },
    },
  ];
}
