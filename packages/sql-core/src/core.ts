import type { CommandHandler, TreeNode, ViewMessageHandler } from "@oneclient/plugin-api";
import { type FastQueries, createFastQueries } from "./fast-queries/api.js";
import { type FastTool, type FastToolsSection, createFastToolsSection } from "./fast-tools/index.js";
import { type FolderStore, createFolderStore } from "./fast-tools/folder.js";
import { type HistoryStore, createHistoryStore } from "./history.js";
import { type QueryWindowFactory, createQueryWindowFactory } from "./query-window.js";
import type { ExecuteQuery } from "./types.js";
import { createQueryViews } from "./views.js";

/** What the core can do for a SQL plugin; everything is on unless the plugin turns it off. */
export interface SqlCoreFeatures {
  /** Query history per connection (`<prefix>.history`, `.deleteHistory`, `.queryHistory`). */
  history?: boolean;
  /** The FAST TOOLS section and its folder (`<prefix>.attachFastToolsFolder`, `.detachFastToolsFolder`). */
  fastTools?: boolean;
  /** Fast Queries in FAST TOOLS (`<prefix>.newFastQuery`, `.runFastQuery`, …). Needs `fastTools`. */
  fastQueries?: boolean;
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
  /** Runs a command body, turning a thrown error into `{ ok: false, error }` (what core shows to the user). */
  action<R extends { ok: true; openNode?: TreeNode }>(fn: () => Promise<R>): Promise<R | { ok: false; error: string }>;
}

/** Context-menu args: core spreads the right-clicked node's `data` in. */
type NodeArg = { connectionId: string; database?: string; fastQueryFile?: string };

export function commandArg<T>(args: unknown[]): T {
  const value = args[0] as T | undefined;
  if (!value) throw new Error("Missing command argument.");
  return value;
}

export function createSqlCore(options: SqlCoreOptions): SqlCore {
  const { prefix } = options;
  const features = { history: true, fastTools: true, fastQueries: true, ...options.features };
  const dataDir = options.dataDir ?? prefix;
  const describe = options.describeError ?? ((err: unknown) => (err instanceof Error ? err.message : String(err)));
  const queryWindow = createQueryWindowFactory(prefix, options.untitledQuery);
  const folders = options.folders ?? createFolderStore(dataDir);
  const history = features.history ? createHistoryStore(dataDir) : undefined;
  const fastQueries = features.fastTools && features.fastQueries ? createFastQueries(prefix, folders, queryWindow) : undefined;

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
  tools.push(...(options.tools ?? []));
  const fastTools = features.fastTools ? createFastToolsSection(prefix, folders, tools) : undefined;

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

  return { prefix, queryWindow, folders, history, commands, views: createQueryViews(options.executeQuery, history), fastTools, fastQueries, action };
}
