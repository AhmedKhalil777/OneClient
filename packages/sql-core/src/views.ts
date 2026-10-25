import type { ViewMessageHandler } from "@oneclient/plugin-api";
import type { HistoryStore } from "./history.js";
import type { ExecuteQuery, QueryRunSummary } from "./types.js";

/**
 * Message hub between the two halves of the query UI:
 *
 *   query window (editor tab)  ──execute/activate──▶  backend  ──update/activate──▶  Query Results (bottom panel)
 *                              ◀──done/goToLine────            ◀──goToLine─────────
 *
 * Results flow straight from the query runner to the panel (never through the
 * editor), and the panel shows whichever window was last active. The latest
 * results per window are cached so the panel can rebuild after a reload.
 */

type Reply = (message: unknown) => void;

export interface WindowInfo {
  server: string;
  login: string;
  version: string;
  database?: string | null | undefined;
}
export type WindowState<R extends QueryRunSummary = QueryRunSummary> = { kind: "running"; started: number } | { kind: "done"; run: R } | { kind: "failed"; error: string };
export interface WindowUpdate<R extends QueryRunSummary = QueryRunSummary> {
  type: "update";
  windowId: string;
  title: string;
  info: WindowInfo | null;
  state: WindowState<R>;
  /** The script that ran — the results panel guesses table names for exports from it. */
  sql?: string;
}

const MAX_CACHED_WINDOWS = 10;

type FromQueryWindow =
  | { type: "hello"; windowId: string }
  | { type: "activate"; windowId: string; title: string }
  | {
      type: "execute";
      windowId: string;
      title: string;
      queryId: string;
      sql: string;
      database?: string;
      lineOffset?: number;
      info: WindowInfo | null;
    };

type FromResults = { type: "hello" } | { type: "goToLine"; windowId: string; line: number };

/** The query window's and the Query Results panel's backend handlers (register them as `<prefix>.query` / `<prefix>.results`). */
export function createQueryViews(executeQuery: ExecuteQuery, history: HistoryStore | undefined): { query: ViewMessageHandler; results: ViewMessageHandler } {
  let resultsReply: Reply | null = null;
  /** Each query window's reply channel. Replies reach every window of that connection, so messages carry windowId. */
  const editorReplies = new Map<string, Reply>();
  const cache = new Map<string, WindowUpdate>();
  let activeWindow: { windowId: string; title: string } | null = null;

  const toResults = (message: unknown) => resultsReply?.(message);

  function remember(update: WindowUpdate) {
    cache.delete(update.windowId); // re-insert = most recent
    cache.set(update.windowId, update);
    while (cache.size > MAX_CACHED_WINDOWS) cache.delete(cache.keys().next().value!);
    toResults(update);
  }

  const query: ViewMessageHandler = {
    async onMessage(message, ctx) {
      const msg = message as FromQueryWindow;
      if (msg.type === "hello") {
        editorReplies.set(msg.windowId, ctx.reply);
        return;
      }
      if (msg.type === "activate") {
        activeWindow = { windowId: msg.windowId, title: msg.title };
        toResults({ type: "activate", ...activeWindow });
        return;
      }
      if (msg.type === "execute") {
        const { windowId, title, queryId, info } = msg;
        activeWindow = { windowId, title };
        if (!ctx.connectionId) {
          ctx.reply({ type: "failed", windowId, queryId, error: "This query window has no connection." });
          return;
        }
        const sql = msg.sql;
        const started = Date.now();
        const record = (entry: Parameters<HistoryStore["record"]>[1]) => void history?.record(ctx.connectionId!, entry).catch(() => undefined);
        remember({ type: "update", windowId, title, info, sql, state: { kind: "running", started } });
        try {
          const run = await executeQuery({
            connectionId: ctx.connectionId,
            windowId,
            queryId,
            sql: msg.sql,
            database: msg.database,
            lineOffset: msg.lineOffset,
          });
          remember({ type: "update", windowId, title, info: info && { ...info, database: run.database }, sql, state: { kind: "done", run } });
          const rows = run.resultSets.reduce((n, rs) => n + rs.totalRows, 0);
          const firstError = run.messages.find((m) => m.kind === "error")?.text;
          record({ sql, database: run.database, status: run.cancelled ? "cancelled" : run.hasErrors ? "error" : "ok", elapsedMs: run.elapsedMs, rows: rows || run.rowsAffected, ...(firstError ? { error: firstError } : {}) });
          ctx.reply({
            type: "done",
            windowId,
            queryId,
            database: run.database,
            hasErrors: run.hasErrors,
            cancelled: run.cancelled,
            elapsedMs: run.elapsedMs,
            rows,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          remember({ type: "update", windowId, title, info, sql, state: { kind: "failed", error } });
          record({ sql, database: msg.database ?? null, status: "error", elapsedMs: Date.now() - started, rows: 0, error });
          ctx.reply({ type: "failed", windowId, queryId, error });
        }
      }
    },
  };

  const results: ViewMessageHandler = {
    onMessage(message, ctx) {
      const msg = message as FromResults;
      if (msg.type === "hello") {
        resultsReply = ctx.reply;
        ctx.reply({ type: "snapshot", windows: [...cache.values()], active: activeWindow });
      } else if (msg.type === "goToLine") {
        editorReplies.get(msg.windowId)?.({ type: "goToLine", windowId: msg.windowId, line: msg.line });
      }
    },
    onDispose() {
      resultsReply = null;
    },
  };

  return { query, results };
}
