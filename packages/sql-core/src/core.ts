import type { CommandHandler, TreeNode, ViewMessageHandler } from "@oneclient/plugin-api";
import { type Background, type BackgroundHost, createBackground } from "./background/manager.js";
import { createBackgroundStore } from "./background/store.js";
import { type FastAggregates, createFastAggregates } from "./aggregate/api.js";
import { type FastQueries, createFastQueries } from "./fast-queries/api.js";
import { type FastTool, type FastToolsSection, createFastToolsSection } from "./fast-tools/index.js";
import { type FolderStore, createFolderStore } from "./fast-tools/folder.js";
import { type HistoryStore, createHistoryStore } from "./history.js";
import { type QueryWindowFactory, createQueryWindowFactory } from "./query-window.js";
import { type CsvImporter, createCsvImporter } from "./import/import.js";
import { type Planner, createPlanner } from "./plan/api.js";
import type { PlanAccess } from "./plan/types.js";
import { type SqlSection, combineSections, createBackgroundSection, createHistorySection } from "./sections.js";
import { type TableEditor, createTableEditor } from "./table-editor/api.js";
import type { TableAccess } from "./table-editor/types.js";
import { withQueryLog } from "./query-log.js";
import type { ExecuteQuery } from "./types.js";
import { createQueryViews } from "./views.js";
import { createAiCommands } from "./ai-tools.js";

/** What the core can do for a SQL plugin; everything is on unless the plugin turns it off. */
export interface SqlCoreFeatures {
  /** Query history per connection (`<prefix>.history`, `.deleteHistory`, `.queryHistory`). */
  history?: boolean;
  /** The FAST TOOLS section and its folder (`<prefix>.attachFastToolsFolder`, `.detachFastToolsFolder`). */
  fastTools?: boolean;
  /** Fast Queries in FAST TOOLS (`<prefix>.newFastQuery`, `.runFastQuery`, …). Needs `fastTools`. */
  fastQueries?: boolean;
  /** Fast Aggregates in FAST TOOLS (`<prefix>.newFastAggregate`, `.aggregate`). Needs `fastTools`, the table editor and `TableAccess.foreignKeys`. */
  fastAggregates?: boolean;
  /** Edit Data on tables (`<prefix>.editData`, `.tableData`): staged changes, SQL review, one-transaction apply. Needs `tableAccess`. */
  tableEditor?: boolean;
  /** Import CSV into a table (`<prefix>.importCsv`, `.importData`): streamed, validated, one transaction. Needs `tableAccess`. */
  importCsv?: boolean;
  /** Execution plans (`<prefix>.explain`, view `<prefix>.plan`). Needs `planAccess`. */
  plan?: boolean;
  /** Create Database… on the Databases folder (`<prefix>.createDatabase`). Needs `createDatabase`. */
  createDatabase?: boolean;
  /**
   * Long-running queries: "⏱ Background" in the query window, the BACKGROUND TASKS section, and tasks in the app's Tasks
   * panel (`<prefix>.runInBackground`, `.backgroundTasks`…). Needs `host`. The QUERY HISTORY section follows `history`.
   */
  background?: boolean;
  /** Commands the AI assistant uses (`<prefix>.ai.schema`, `.ai.query`, `.ai.execute`) — see ai-tools.ts. */
  aiTools?: boolean;
}

export interface SqlCoreOptions {
  /** Id prefix of the plugin's commands, views and node types: "mssql" → `mssql.executeQuery`, `mssql.query`, … */
  prefix: string;
  /** The plugin's folder under `~/.oneclient` (history, Fast Tools folders). Default: the prefix. */
  dataDir?: string;
  /** Title of new query windows, numbered: "SQLQuery" (default) → SQLQuery1.sql, SQLQuery2.sql, … */
  untitledQuery?: string;
  executeQuery: ExecuteQuery;
  cancelQuery(queryId: string): boolean | Promise<boolean>;
  /** Throws when the connection isn't open (commands that need the server call it first). */
  ensureConnected(connectionId: string): void;
  /** The message shown when a command fails. Default: the error's message. */
  describeError?(err: unknown): string;
  features?: SqlCoreFeatures;
  /** The Fast Tools folder store, when the plugin's own tools need it before the core exists (see `createFolderStore`). */
  folders?: FolderStore;
  /** The plugin's own Fast Tools, listed after the core's. */
  tools?: FastTool[];
  /** The dialect's side of the table data editor. */
  tableAccess?: TableAccess;
  /** The dialect's side of the execution plan viewer. */
  planAccess?: PlanAccess;
  /**
   * The dialect's CREATE DATABASE. `options` are the extra fields of the command's form (collation, encoding…): the
   * dialect validates the ones it uses. The core has already checked the name.
   */
  createDatabase?: (connectionId: string, name: string, options: Record<string, unknown>) => Promise<void>;
  /** The plugin context (or anything with `tasks` and `refreshExplorer`): background tasks register with the app through it. */
  host?: BackgroundHost;
  /** Closes the dedicated session of a query window (a background task's own one, when it ends). */
  releaseWindow?: (connectionId: string, windowId: string) => Promise<void>;
  /** "SQL Server", "PostgreSQL"… — used in task titles. Default: the prefix. */
  productName?: string;
}

export interface SqlCore {
  prefix: string;
  queryWindow: QueryWindowFactory;
  folders: FolderStore;
  history: HistoryStore | undefined;
  /** Register these (`registerCommand`); a feature that's off registers nothing. */
  commands: CommandHandler[];
  /** `registerView(`${prefix}.query`, views.query)` and `registerView(`${prefix}.results`, views.results)`. */
  views: { query: ViewMessageHandler; results: ViewMessageHandler };
  /** The FAST TOOLS section's tree, for the plugin's explorer provider; undefined when `fastTools` is off. */
  fastTools: FastToolsSection | undefined;
  fastQueries: FastQueries | undefined;
  fastAggregates: FastAggregates | undefined;
  /** FAST TOOLS, QUERY HISTORY and BACKGROUND TASKS as one: hand it to the plugin's explorer provider. */
  sections: ReturnType<typeof combineSections>;
  background: Background | undefined;
  tableEditor: TableEditor | undefined;
  csvImporter: CsvImporter | undefined;
  planner: Planner | undefined;
  /** Runs a command body, turning a thrown error into `{ ok: false, error }` (what core shows to the user). */
  action<R extends { ok: true; openNode?: TreeNode }>(fn: () => Promise<R>): Promise<R | { ok: false; error: string }>;
}

/** Context-menu args: core spreads the right-clicked node's `data` in. */
type NodeArg = { connectionId: string; database?: string; schema?: string; name?: string; fastQueryFile?: string };

/** A database name the user typed: what every dialect can quote safely. */
export function checkDatabaseName(name: string | undefined): string {
  const n = name?.trim() ?? "";
  if (!n) throw new Error("Give the database a name.");
  if (n.length > 128) throw new Error("A database name can be at most 128 characters.");
  if ([...n].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) throw new Error("A database name can't contain control characters.");
  return n;
}

export function commandArg<T>(args: unknown[]): T {
  const value = args[0] as T | undefined;
  if (!value) throw new Error("Missing command argument.");
  return value;
}

export function createSqlCore(rawOptions: SqlCoreOptions): SqlCore {
  const describeForLog = rawOptions.describeError ?? ((err: unknown) => (err instanceof Error ? err.message : String(err)));
  // Every query (editor, background tasks, FAST TOOLS, AI tools) goes through this one wrapper, so all get logged.
  const options: SqlCoreOptions = { ...rawOptions, executeQuery: withQueryLog(rawOptions.executeQuery, rawOptions.host?.createOutputChannel?.("Queries"), describeForLog) };
  const { prefix } = options;
  const features = { history: true, fastTools: true, fastQueries: true, fastAggregates: true, tableEditor: true, importCsv: true, plan: true, createDatabase: true, background: true, aiTools: true, ...options.features };
  const dataDir = options.dataDir ?? prefix;
  const describe = options.describeError ?? ((err: unknown) => (err instanceof Error ? err.message : String(err)));
  const queryWindow = createQueryWindowFactory(prefix, options.untitledQuery);
  const folders = options.folders ?? createFolderStore(dataDir);
  const history = features.history ? createHistoryStore(dataDir) : undefined;
  const fastQueries = features.fastTools && features.fastQueries ? createFastQueries(prefix, folders, queryWindow) : undefined;

  const tableEditor = features.tableEditor && options.tableAccess ? createTableEditor(prefix, options.tableAccess, describe) : undefined;

  const fastAggregates =
    features.fastTools && features.fastAggregates && tableEditor && options.tableAccess?.foreignKeys
      ? createFastAggregates(prefix, folders, options.tableAccess, tableEditor.columns, describe)
      : undefined;

  const csvImporter = features.importCsv && tableEditor && options.tableAccess ? createCsvImporter(prefix, options.tableAccess, describe, tableEditor.columns) : undefined;

  const planner = features.plan && options.planAccess ? createPlanner(prefix, options.planAccess, describe) : undefined;

  const tools: FastTool[] = [];
  if (fastQueries) {
    tools.push({
      id: "fastQueries",
      label: "Fast Queries",
      icon: "$(play)",
      rootNodeType: `${prefix}.fastQueriesRoot`,
      nodeTypes: [`${prefix}.fastQueryGroup`],
      children: (_cid, folder, node) => fastQueries.nodes(folder, node),
    });
  }
  if (fastAggregates) {
    tools.push({
      id: "fastAggregates",
      label: "Fast Aggregates",
      icon: "$(cube)",
      rootNodeType: `${prefix}.fastAggregatesRoot`,
      nodeTypes: [],
      children: (_cid, folder) => fastAggregates.nodes(folder),
    });
  }
  tools.push(...(options.tools ?? []));
  const fastTools = features.fastTools ? createFastToolsSection(prefix, folders, tools) : undefined;

  const background =
    features.background && options.host
      ? createBackground({ productName: options.productName ?? prefix, host: options.host, store: createBackgroundStore(dataDir), executeQuery: options.executeQuery, cancelQuery: options.cancelQuery, releaseWindow: options.releaseWindow, history, describeError: describe })
      : undefined;

  const sectionList: SqlSection[] = [];
  if (fastTools) sectionList.push(fastTools);
  if (history) sectionList.push(createHistorySection(prefix, history, queryWindow));
  if (background) sectionList.push(createBackgroundSection(prefix, background));
  const sections = combineSections(sectionList);

  async function action<R extends { ok: true; openNode?: TreeNode }>(fn: () => Promise<R>): Promise<R | { ok: false; error: string }> {
    try {
      return await fn();
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }
  const arg = commandArg;
  const cmd = (id: string, execute: CommandHandler["execute"]): CommandHandler => ({ commandId: `${prefix}.${id}`, execute });

  const commands: CommandHandler[] = [
    // ---- Used by the query window (view == '<prefix>.query') ----
    cmd("executeQuery", async (args) => {
      const a = arg<{ connectionId: string; windowId: string; queryId: string; database?: string; sql: string; lineOffset?: number }>(args);
      if (typeof a.sql !== "string" || !a.windowId || !a.queryId) return { ok: false, error: "Invalid query request." };
      return options.executeQuery(a);
    }),
    cmd("cancelQuery", async (args) => {
      const { queryId } = arg<{ queryId: string }>(args);
      return { ok: await options.cancelQuery(queryId) };
    }),
  ];

  if (history) {
    commands.push(
      cmd("queryHistory", (args) =>
        action(async () => {
          const { connectionId, database } = arg<NodeArg>(args);
          options.ensureConnected(connectionId);
          return { ok: true, openNode: queryWindow({ database, history: true, title: "Query History" }) };
        }),
      ),
      cmd("history", async (args) => {
        const { connectionId, search, limit } = arg<{ connectionId: string; search?: string; limit?: number }>(args);
        return history.list(connectionId, { ...(search ? { search } : {}), ...(limit ? { limit } : {}) });
      }),
      cmd("deleteHistory", async (args) => {
        const { connectionId, id } = arg<{ connectionId: string; id?: string }>(args);
        await history.remove(connectionId, id);
        return { ok: true };
      }),
    );
  }

  if (history) {
    commands.push(
      // The QUERY HISTORY section's menu: an entry is run in a window of its own, in the background, or forgotten.
      cmd("runHistoryEntry", (args) =>
        action(async () => {
          const { connectionId, historyId } = arg<NodeArg & { historyId?: string }>(args);
          options.ensureConnected(connectionId);
          const e = await history.get(connectionId, String(historyId ?? ""));
          if (!e) throw new Error("That history entry no longer exists.");
          return { ok: true, openNode: queryWindow({ sql: e.sql, database: e.database ?? undefined, autorun: true }) };
        }),
      ),
      cmd("runHistoryEntryInBackground", (args) =>
        action(async () => {
          const { connectionId, historyId } = arg<NodeArg & { historyId?: string }>(args);
          options.ensureConnected(connectionId);
          if (!background) throw new Error("Background tasks aren't available here.");
          const e = await history.get(connectionId, String(historyId ?? ""));
          if (!e) throw new Error("That history entry no longer exists.");
          await background.start({ connectionId, sql: e.sql, database: e.database ?? undefined });
          return { ok: true };
        }),
      ),
      cmd("deleteHistoryEntry", (args) =>
        action(async () => {
          const { connectionId, historyId } = arg<NodeArg & { historyId?: string }>(args);
          await history.remove(connectionId, String(historyId ?? ""));
          return { ok: true };
        }),
      ),
      cmd("clearQueryHistory", (args) =>
        action(async () => {
          const { connectionId } = arg<NodeArg>(args);
          await history.remove(connectionId);
          return { ok: true };
        }),
      ),
    );
  }

  if (background) {
    commands.push(
      // The query window's ⏱ Background: the script runs on its own connection, at app level.
      cmd("runInBackground", (args) =>
        action(async () => {
          const a = arg<{ connectionId: string; sql?: string; database?: string; title?: string }>(args);
          options.ensureConnected(a.connectionId);
          const task = await background.start({ connectionId: a.connectionId, sql: String(a.sql ?? ""), database: a.database || undefined, title: a.title });
          return { ok: true, id: task.id, title: task.title };
        }),
      ),
      // The task view's backend: list / get / cancel / remove / clear.
      cmd("backgroundTasks", async (args) => {
        try {
          const { connectionId, method, id } = arg<{ connectionId: string; method?: string; id?: string }>(args);
          switch (method) {
            case "list":
              return { ok: true, data: await background.list(connectionId) };
            case "get":
              return { ok: true, data: await background.get(connectionId, String(id)) };
            case "cancel":
              return { ok: true, data: await background.cancel(String(id)) };
            case "remove":
              await background.remove(connectionId, String(id));
              return { ok: true, data: true };
            case "rerun": {
              const t = await background.get(connectionId, String(id));
              return { ok: true, data: await background.start({ connectionId, sql: t.sql, database: t.database ?? undefined }) };
            }
            default:
              return { ok: false, error: `Unknown operation "${String(method)}".` };
          }
        } catch (err) {
          return { ok: false, error: describe(err) };
        }
      }),
      cmd("cancelBackgroundTask", (args) =>
        action(async () => {
          const { backgroundId } = arg<NodeArg & { backgroundId?: string }>(args);
          await background.cancel(String(backgroundId ?? ""));
          return { ok: true };
        }),
      ),
      cmd("removeBackgroundTask", (args) =>
        action(async () => {
          const { connectionId, backgroundId } = arg<NodeArg & { backgroundId?: string }>(args);
          await background.remove(connectionId, String(backgroundId ?? ""));
          return { ok: true };
        }),
      ),
      cmd("clearBackgroundTasks", (args) =>
        action(async () => {
          const { connectionId } = arg<NodeArg>(args);
          await background.clearFinished(connectionId);
          return { ok: true };
        }),
      ),
      cmd("rerunInBackground", (args) =>
        action(async () => {
          const { connectionId, backgroundId } = arg<NodeArg & { backgroundId?: string }>(args);
          options.ensureConnected(connectionId);
          const t = await background.get(connectionId, String(backgroundId ?? ""));
          await background.start({ connectionId, sql: t.sql, database: t.database ?? undefined });
          return { ok: true };
        }),
      ),
      cmd("openBackgroundSql", (args) =>
        action(async () => {
          const { connectionId, backgroundId } = arg<NodeArg & { backgroundId?: string }>(args);
          options.ensureConnected(connectionId);
          const t = await background.get(connectionId, String(backgroundId ?? ""));
          return { ok: true, openNode: queryWindow({ sql: t.sql, database: t.database ?? undefined }) };
        }),
      ),
    );
  }

  if (fastTools) {
    commands.push(
      cmd("attachFastToolsFolder", (args) =>
        action(async () => {
          const { connectionId, folder } = arg<NodeArg & { folder?: string }>(args);
          await folders.attach(connectionId, String(folder ?? ""));
          return { ok: true };
        }),
      ),
      cmd("detachFastToolsFolder", (args) =>
        action(async () => {
          const { connectionId } = arg<NodeArg>(args);
          folders.detach(connectionId);
          return { ok: true };
        }),
      ),
    );
  }

  if (fastQueries) {
    commands.push(
      cmd("newFastQuery", (args) =>
        action(async () => {
          const { connectionId, database } = arg<NodeArg>(args);
          options.ensureConnected(connectionId);
          return { ok: true, openNode: fastQueries.newWindow(database) };
        }),
      ),
      cmd("runFastQuery", (args) =>
        action(async () => {
          const { connectionId, fastQueryFile, database } = arg<NodeArg>(args);
          options.ensureConnected(connectionId);
          return { ok: true, openNode: await fastQueries.run(connectionId, String(fastQueryFile ?? ""), database) };
        }),
      ),
      cmd("runFastQueryOn", (args) =>
        action(async () => {
          const { connectionId, fastQueryFile, targetDatabase } = arg<NodeArg & { targetDatabase?: string }>(args);
          options.ensureConnected(connectionId);
          const db = String(targetDatabase ?? "").trim();
          if (!db) throw new Error("Which database?");
          return { ok: true, openNode: await fastQueries.run(connectionId, String(fastQueryFile ?? ""), db) };
        }),
      ),
      // The query window's ★ Save as Fast Query.
      cmd("saveFastQuery", (args) =>
        action(async () => {
          const a = arg<{ connectionId: string; file?: string; name?: string; sql?: string; database?: string; description?: string }>(args);
          const saved = await fastQueries.save(a.connectionId, { name: String(a.name ?? ""), sql: String(a.sql ?? ""), database: a.database || undefined, description: a.description || undefined }, a.file || undefined);
          return { ok: true, ...saved };
        }),
      ),
      cmd("renameFastQuery", (args) =>
        action(async () => {
          const { connectionId, fastQueryFile, newName } = arg<NodeArg & { newName?: string }>(args);
          await fastQueries.rename(connectionId, String(fastQueryFile ?? ""), String(newName ?? ""));
          return { ok: true };
        }),
      ),
      cmd("deleteFastQuery", (args) =>
        action(async () => {
          const { connectionId, fastQueryFile } = arg<NodeArg>(args);
          await fastQueries.remove(connectionId, String(fastQueryFile ?? ""));
          return { ok: true };
        }),
      ),
    );
  }

  if (tableEditor) {
    commands.push(
      tableEditor.command,
      cmd("editData", (args) =>
        action(async () => {
          const { connectionId, database, schema, name } = arg<NodeArg>(args);
          options.ensureConnected(connectionId);
          if (!database || !schema || !name) throw new Error("Which table?");
          return { ok: true, openNode: tableEditor.tab({ database, schema, table: name }) };
        }),
      ),
    );
  }

  if (fastAggregates) {
    commands.push(
      fastAggregates.command,
      cmd("newFastAggregate", (args) =>
        action(async () => {
          const { connectionId, database, schema, name } = arg<NodeArg>(args);
          options.ensureConnected(connectionId);
          if (!database || !schema || !name) throw new Error("Which table?");
          const made = await fastAggregates.create(connectionId, { database, schema, table: name });
          return { ok: true, openNode: fastAggregates.tab(made.file, made.name) };
        }),
      ),
      cmd("renameFastAggregate", (args) =>
        action(async () => {
          const { connectionId, aggregateFile, newName } = arg<NodeArg & { aggregateFile?: string; newName?: string }>(args);
          await fastAggregates.rename(connectionId, String(aggregateFile ?? ""), String(newName ?? ""));
          return { ok: true };
        }),
      ),
      cmd("deleteFastAggregate", (args) =>
        action(async () => {
          const { connectionId, aggregateFile } = arg<NodeArg & { aggregateFile?: string }>(args);
          await fastAggregates.remove(connectionId, String(aggregateFile ?? ""));
          return { ok: true };
        }),
      ),
    );
  }

  if (csvImporter) {
    commands.push(
      csvImporter.command,
      cmd("importCsv", (args) =>
        action(async () => {
          const { connectionId, database, schema, name, file } = arg<NodeArg & { file?: string }>(args);
          options.ensureConnected(connectionId);
          if (!database || !schema || !name) throw new Error("Which table?");
          if (!file?.trim()) throw new Error("Choose a CSV file.");
          return { ok: true, openNode: csvImporter.tab({ database, schema, table: name }, file.trim()) };
        }),
      ),
    );
  }

  if (planner) commands.push(planner.command);

  const createDatabase = options.createDatabase;
  if (features.createDatabase && createDatabase) {
    commands.push(
      cmd("createDatabase", (args) =>
        action(async () => {
          const { connectionId, name, ...rest } = arg<{ connectionId: string; name?: string } & Record<string, unknown>>(args);
          options.ensureConnected(connectionId);
          const checked = checkDatabaseName(name);
          await createDatabase(connectionId, checked, rest);
          return { ok: true };
        }),
      ),
    );
  }

  if (features.aiTools) commands.push(...createAiCommands({ prefix, executeQuery: options.executeQuery, ensureConnected: options.ensureConnected, releaseWindow: options.releaseWindow, describeError: describe }));

  return { prefix, queryWindow, folders, history, commands, views: createQueryViews(options.executeQuery, history), fastTools, fastQueries, fastAggregates, sections, background, tableEditor, csvImporter, planner, action };
}
