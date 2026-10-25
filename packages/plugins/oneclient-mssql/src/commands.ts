import type { CommandHandler, TreeNode } from "@oneclient/plugin-api";
import { type SqlCore, commandArg as arg } from "@oneclient/sql-core";
import { describeConnection, quoteIdent } from "./config.js";
import type { NodeData } from "./explorer-provider.js";
import {
  completionCatalog,
  formatType,
  listColumns,
  listDatabases,
  listParameters,
  objectDefinition,
  qualified,
} from "./metadata.js";
import { callFakerApi, deleteSavedFaker, fakerTab, renameSavedFaker, runSavedFaker } from "./faker/api.js";
import { searchObjects } from "./search.js";
import { erModel } from "./diagram.js";
import { requireSession } from "./sessions.js";

/** Context-menu args: core spreads the right-clicked node's `data` in (see CommandContribution.when). */
type NodeArg = { connectionId: string } & NodeData;

/** The ER diagram tab of a database; one tab per database, so opening it again focuses it. */
function diagramTab(database: string, focus?: string): TreeNode {
  const title = `Diagram: ${database}`;
  const params: Record<string, string> = { database };
  if (focus) params.focus = focus;
  return { id: `diagram:${database}`, label: title, nodeType: "mssql.diagram", collapsible: "none", openView: { viewId: "mssql.diagram", title, icon: "$(diagram)", params } };
}

/** SQL Server's own commands; query execution, history and Fast Queries come from the SQL core (`core.commands`). */
export function createCommandHandlers(core: SqlCore): CommandHandler[] {
  const { action, queryWindow } = core;
  return [
    {
      // The diagram view's data: tables, columns, keys and relations.
      commandId: "mssql.erModel",
      execute: (args) => {
        const { connectionId, database, schema } = arg<{ connectionId: string; database?: string; schema?: string }>(args);
        if (!database) throw new Error("Which database?");
        return erModel(requireSession(connectionId).pool, database, schema || undefined);
      },
    },
    {
      commandId: "mssql.diagram",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", schema, name } = arg<NodeArg>(args);
          const session = requireSession(connectionId);
          const db = database || (await session.pool.request().query<{ db: string }>("SELECT DB_NAME() AS db")).recordset[0]!.db;
          return { ok: true, openNode: diagramTab(db, schema && name ? `${schema}.${name}` : undefined) };
        }),
    },
    // ---- Fake data ("fakers") ------------------------------------------------------------------
    {
      // The Generate Data view's backend.
      commandId: "mssql.faker",
      execute: (args) => {
        const { connectionId, method, params } = arg<{ connectionId?: string; method?: string; params?: Record<string, unknown> }>(args);
        return callFakerApi(connectionId, String(method ?? ""), params ?? {});
      },
    },
    {
      commandId: "mssql.generateData",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", schema = "", name = "" } = arg<NodeArg>(args);
          requireSession(connectionId);
          return { ok: true, openNode: fakerTab({ database, schema, table: name }, `Fake data: ${schema}.${name}`) };
        }),
    },
    {
      commandId: "mssql.newFaker",
      execute: (args) =>
        action(async () => {
          const { connectionId, database } = arg<NodeArg>(args);
          requireSession(connectionId);
          return { ok: true, openNode: fakerTab(database ? { database } : {}, "New faker") };
        }),
    },
    {
      commandId: "mssql.runFaker",
      execute: (args) =>
        action(async () => {
          const { connectionId, fakerFile, database } = arg<NodeArg>(args);
          const { doc, database: db, result } = await runSavedFaker(connectionId, String(fakerFile ?? ""), database);
          const { schema, table } = doc.rule;
          const summary = result.tables.map((t) => `${t.rows} row(s) into ${t.schema}.${t.table}`).join("; ");
          const sql = `-- Faker "${doc.name}" inserted ${summary}\nSELECT TOP (1000) * FROM ${qualified(db, schema, table)}`;
          return { ok: true, openNode: queryWindow({ database: db, sql, autorun: true }) };
        }),
    },
    {
      commandId: "mssql.renameFaker",
      execute: (args) =>
        action(async () => {
          const { connectionId, fakerFile, newName } = arg<NodeArg & { newName?: string }>(args);
          await renameSavedFaker(connectionId, String(fakerFile ?? ""), String(newName ?? ""));
          return { ok: true };
        }),
    },
    {
      commandId: "mssql.deleteFaker",
      execute: (args) =>
        action(async () => {
          const { connectionId, fakerFile } = arg<NodeArg>(args);
          await deleteSavedFaker(connectionId, String(fakerFile ?? ""));
          return { ok: true };
        }),
    },
    {
      // Global search provider (contributes.searchProviders): tables, views, procedures and functions.
      commandId: "mssql.search",
      execute: (args) => {
        const { connectionId, query, limit } = arg<{ connectionId: string; query: string; limit?: number }>(args);
        return searchObjects(connectionId, String(query ?? ""), Math.min(50, Math.max(1, limit ?? 20)));
      },
    },
    {
      commandId: "mssql.newQuery",
      execute: (args) =>
        action(async () => {
          const { connectionId, database } = arg<NodeArg>(args);
          requireSession(connectionId);
          return { ok: true, openNode: queryWindow({ database }) };
        }),
    },
    {
      commandId: "mssql.selectTop",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", schema = "", name = "" } = arg<NodeArg>(args);
          const { pool } = requireSession(connectionId);
          const cols = await listColumns(pool, database, schema, name);
          const list = cols.length ? cols.map((c) => quoteIdent(c.name)).join("\n      ,") : "*";
          const sql =
            `/****** Script for SelectTopNRows command from oneClient ******/\n` +
            `SELECT TOP (1000) ${list}\n  FROM ${qualified(database, schema, name)}`;
          return { ok: true, openNode: queryWindow({ database, sql, autorun: true }) };
        }),
    },
    {
      commandId: "mssql.scriptCreate",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", schema = "", name = "" } = arg<NodeArg>(args);
          const { pool } = requireSession(connectionId);
          const cols = await listColumns(pool, database, schema, name);
          const pk = cols.filter((c) => c.is_pk).map((c) => quoteIdent(c.name));
          const lines = cols.map((c) => {
            const parts = [`\t${quoteIdent(c.name)} ${c.is_computed ? "AS /* computed */ NULL" : formatType(c)}`];
            if (c.is_identity) parts.push("IDENTITY(1,1)");
            if (!c.is_computed) parts.push(c.is_nullable ? "NULL" : "NOT NULL");
            if (c.default_definition) parts.push(`DEFAULT ${c.default_definition}`);
            return parts.join(" ");
          });
          if (pk.length) lines.push(`\tCONSTRAINT ${quoteIdent(`PK_${name}`)} PRIMARY KEY (${pk.join(", ")})`);
          const sql =
            `USE ${quoteIdent(database)}\nGO\n\n` +
            `-- Basic CREATE script (columns, defaults, primary key). Foreign keys, indexes and other constraints are not scripted.\n` +
            `CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(name)}(\n${lines.join(",\n")}\n)\nGO\n`;
          return { ok: true, openNode: queryWindow({ database, sql }) };
        }),
    },
    {
      commandId: "mssql.scriptModify",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", schema = "", name = "" } = arg<NodeArg>(args);
          const { pool } = requireSession(connectionId);
          const definition = await objectDefinition(pool, database, schema, name);
          if (definition === null) throw new Error(`Can't read the definition of ${schema}.${name} (encrypted, or no VIEW DEFINITION permission).`);
          // CREATE OR ALTER (SQL Server 2016 SP1+) works whether or not the object still exists.
          const altered = definition.replace(/\bCREATE(\s+OR\s+ALTER)?(?=\s+(VIEW|PROC|PROCEDURE|FUNCTION|TRIGGER)\b)/i, "CREATE OR ALTER");
          const sql = `USE ${quoteIdent(database)}\nGO\n\n${altered.trim()}\nGO\n`;
          return { ok: true, openNode: queryWindow({ database, sql, title: `${schema}.${name}.sql` }) };
        }),
    },
    {
      commandId: "mssql.scriptExecute",
      execute: (args) =>
        action(async () => {
          const { connectionId, database = "", schema = "", name = "" } = arg<NodeArg>(args);
          const { pool } = requireSession(connectionId);
          const params = await listParameters(pool, database, schema, name);
          const declares = params.map((p) => `DECLARE ${p.name} ${formatType(p)}`);
          const assignments = params.map((p) => `${p.name} = ${p.name}${p.is_output ? " OUTPUT" : ""}`);
          const sql =
            `USE ${quoteIdent(database)}\nGO\n\n` +
            `DECLARE @RC int\n${declares.join("\n")}${declares.length ? "\n" : ""}\n` +
            `-- TODO: Set parameter values here.\n\n` +
            `EXECUTE @RC = ${quoteIdent(schema)}.${quoteIdent(name)}${assignments.length ? `\n   ${assignments.join("\n  ,")}` : ""}\nGO\n`;
          return { ok: true, openNode: queryWindow({ database, sql }) };
        }),
    },


    // ---- Used by the query window (view == 'mssql.query') ----
    {
      commandId: "mssql.listDatabases",
      async execute(args) {
        const { connectionId } = arg<{ connectionId: string }>(args);
        const { pool } = requireSession(connectionId);
        return (await listDatabases(pool)).filter((d) => d.state_desc === "ONLINE").map((d) => d.name);
      },
    },
    {
      commandId: "mssql.completionCatalog",
      async execute(args) {
        const { connectionId, database } = arg<{ connectionId: string; database?: string }>(args);
        return completionCatalog(requireSession(connectionId).pool, database || undefined);
      },
    },
    {
      commandId: "mssql.serverInfo",
      async execute(args) {
        const { connectionId } = arg<{ connectionId: string }>(args);
        const session = requireSession(connectionId);
        const r = await session.pool
          .request()
          .query<{ version: string }>("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version");
        return { ...describeConnection(session.config), version: r.recordset[0]?.version ?? "" };
      },
    },
  ];
}
