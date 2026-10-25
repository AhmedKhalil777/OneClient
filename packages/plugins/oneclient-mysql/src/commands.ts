import type { CommandHandler, TreeNode } from "@oneclient/plugin-api";
import { type SqlCore, commandArg as arg } from "@oneclient/sql-core";
import { describeConnection, qualified, quoteIdent } from "./config.js";
import { erModel } from "./diagram.js";
import type { NodeData } from "./explorer-provider.js";
import { type ObjectKind, completionCatalog, listColumns, listDatabases, listParameters, objectDefinition } from "./metadata.js";
import { searchObjects } from "./search.js";
import { poolFor, requireSession } from "./sessions.js";

/** Context-menu args: core spreads the right-clicked node's `data` in (see CommandContribution.when). */
type NodeArg = { connectionId: string } & NodeData;

/** The ER diagram tab of a database; one tab per database, so opening it again focuses it. */
function diagramTab(database: string, focus?: string): TreeNode {
  const title = `Diagram: ${database}`;
  const params: Record<string, string> = { database };
  if (focus) params.focus = focus;
  return { id: `diagram:${database}`, label: title, nodeType: "mysql.diagram", collapsible: "none", openView: { viewId: "mysql.diagram", title, icon: "$(diagram)", params } };
}

/** `CREATE` text ends with `;` when it's run as a script; routines need DELIMITER because their body holds `;`. */
function asScript(kind: ObjectKind, definition: string): string {
  const body = definition.trimEnd().replace(/;$/, "");
  return kind === "procedures" || kind === "functions" ? `DELIMITER //\n${body}//\nDELIMITER ;\n` : `${body};\n`;
}

/** MySQL's own commands; query execution, history and Fast Queries come from the SQL core (`core.commands`). */
export function createCommandHandlers(core: SqlCore): CommandHandler[] {
  const { action, queryWindow } = core;
  return [
    {
      // The diagram view's data: tables, columns, keys and relations.
      commandId: "mysql.erModel",
      execute: (args) => {
        const { connectionId, database } = arg<{ connectionId: string; database?: string }>(args);
        if (!database) throw new Error("Which database?");
        return erModel(poolFor(connectionId), database);
      },
    },
    {
      commandId: "mysql.diagram",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", name, kind } = arg<NodeArg>(args);
          requireSession(connectionId);
          const db = database || ((await poolFor(connectionId).query("SELECT DATABASE() AS db")) as unknown as [Array<{ db: string | null }>])[0][0]?.db;
          if (!db) throw new Error("Which database?");
          return { ok: true, openNode: diagramTab(db, name && (kind === "tables" || !kind) ? `${db}.${name}` : undefined) };
        }),
    },
    {
      // Global search provider (contributes.searchProviders).
      commandId: "mysql.search",
      execute: (args) => {
        const { connectionId, query, limit } = arg<{ connectionId: string; query: string; limit?: number }>(args);
        return searchObjects(connectionId, String(query ?? ""), Math.min(50, Math.max(1, limit ?? 20)));
      },
    },
    {
      commandId: "mysql.newQuery",
      execute: (args) =>
        action(async () => {
          const { connectionId, database } = arg<NodeArg>(args);
          requireSession(connectionId);
          return { ok: true, openNode: queryWindow({ database }) };
        }),
    },
    {
      commandId: "mysql.selectTop",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", name = "" } = arg<NodeArg>(args);
          const cols = await listColumns(poolFor(connectionId), database, name);
          const list = cols.length ? cols.map((c) => quoteIdent(c.name)).join(",\n       ") : "*";
          const sql = `SELECT ${list}\n  FROM ${qualified(database, name)}\n LIMIT 1000;`;
          return { ok: true, openNode: queryWindow({ database, sql, autorun: true, title: `${name}.sql` }) };
        }),
    },
    {
      commandId: "mysql.countRows",
      execute: (args) =>
        action(async () => {
          const { database = "", name = "" } = arg<NodeArg>(args);
          return { ok: true, openNode: queryWindow({ database, sql: `SELECT COUNT(*) FROM ${qualified(database, name)};`, autorun: true }) };
        }),
    },
    {
      commandId: "mysql.scriptCreate",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", name = "" } = arg<NodeArg>(args);
          const ddl = await objectDefinition(poolFor(connectionId), "tables", database, name);
          if (!ddl) throw new Error(`Can't read the definition of ${database}.${name}.`);
          return { ok: true, openNode: queryWindow({ database, sql: asScript("tables", ddl), title: `${name}.sql` }) };
        }),
    },
    {
      commandId: "mysql.scriptInsert",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", name = "" } = arg<NodeArg>(args);
          const cols = (await listColumns(poolFor(connectionId), database, name)).filter((c) => !c.generated);
          const sql =
            `INSERT INTO ${qualified(database, name)} (\n    ${cols.map((c) => quoteIdent(c.name)).join(",\n    ")}\n) VALUES (\n    ` +
            `${cols.map((c) => `NULL /* ${c.name} ${c.type}${c.default !== null ? ` (default ${c.default})` : ""} */`).join(",\n    ")}\n);`;
          return { ok: true, openNode: queryWindow({ database, sql, title: `${name}-insert.sql` }) };
        }),
    },
    {
      commandId: "mysql.scriptModify",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", name = "", kind = "views" } = arg<NodeArg>(args);
          const definition = await objectDefinition(poolFor(connectionId), kind, database, name);
          if (definition === null) throw new Error(`Can't read the definition of ${database}.${name} (no privilege, or it was dropped).`);
          const drop = kind === "views" ? `DROP VIEW IF EXISTS ${qualified(database, name)};\n` : kind === "procedures" ? `DROP PROCEDURE IF EXISTS ${qualified(database, name)};\n` : kind === "functions" ? `DROP FUNCTION IF EXISTS ${qualified(database, name)};\n` : "";
          return { ok: true, openNode: queryWindow({ database, sql: `-- MySQL can't alter a ${kind.replace(/s$/, "")} in place: drop it and create it again.\n${drop}${asScript(kind, definition)}`, title: `${name}.sql` }) };
        }),
    },
    {
      commandId: "mysql.scriptExecute",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", name = "", kind } = arg<NodeArg>(args);
          const params = await listParameters(poolFor(connectionId), database, name);
          const values = params.map((p) => (p.mode === "OUT" ? `@${p.name.replace(/^@/, "")}` : `NULL /* ${p.name} ${p.type}${p.mode === "INOUT" ? " (INOUT: use a @variable)" : ""} */`));
          const call = `${qualified(database, name)}(${values.join(", ")})`;
          const sql = `-- TODO: set the parameter values.\n${kind === "procedures" ? `CALL ${call}` : `SELECT ${call}`};\n`;
          return { ok: true, openNode: queryWindow({ database, sql }) };
        }),
    },

    // ---- Used by the query window (view == 'mysql.query') ----
    {
      commandId: "mysql.listDatabases",
      async execute(args) {
        const { connectionId } = arg<{ connectionId: string }>(args);
        return (await listDatabases(poolFor(connectionId))).filter((d) => !d.isSystem).map((d) => d.name);
      },
    },
    {
      commandId: "mysql.completionCatalog",
      async execute(args) {
        const { connectionId, database } = arg<{ connectionId: string; database?: string }>(args);
        return completionCatalog(poolFor(connectionId), database || undefined);
      },
    },
    {
      commandId: "mysql.serverInfo",
      async execute(args) {
        const { connectionId } = arg<{ connectionId: string }>(args);
        const session = requireSession(connectionId);
        const [r] = (await poolFor(connectionId).query("SELECT VERSION() AS version")) as unknown as [Array<{ version: string }>];
        const version = r[0]?.version ?? "";
        return { ...describeConnection(session.config), version: /mariadb/i.test(version) ? version : `MySQL ${version}` };
      },
    },
  ];
}
