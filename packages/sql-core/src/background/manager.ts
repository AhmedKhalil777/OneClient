import type { Tasks } from "@oneclient/plugin-api";
import type { HistoryStore } from "../history.js";
import { summarize } from "../sql-text.js";
import type { ExecuteQuery } from "../types.js";
import type { BackgroundStore } from "./store.js";
import type { BackgroundResult, BackgroundTaskDetail, BackgroundTaskInfo } from "./types.js";

/** What the manager needs from the app: the plugin context has both (`context.tasks`, `context.refreshExplorer`). */
export interface BackgroundHost {
  tasks: Tasks;
  refreshExplorer(connectionId: string): void;
}

export interface BackgroundOptions {
  /** "SQL Server", "PostgreSQL"… — prefixes the task's title in the Tasks panel. */
  productName: string;
  host: BackgroundHost;
  store: BackgroundStore;
  executeQuery: ExecuteQuery;
  cancelQuery(queryId: string): boolean | Promise<boolean>;
  /** Closes the task's own database session when it ends. */
  releaseWindow?: ((connectionId: string, windowId: string) => Promise<void>) | undefined;
  history?: HistoryStore | undefined;
  describeError(err: unknown): string;
}

export interface Background {
  start(args: { connectionId: string; sql: string; database?: string | undefined; title?: string | undefined }): Promise<BackgroundTaskInfo>;
  list(connectionId: string): Promise<BackgroundTaskInfo[]>;
  get(connectionId: string, id: string): Promise<BackgroundTaskDetail>;
  cancel(id: string): Promise<boolean>;
  remove(connectionId: string, id: string): Promise<void>;
  clearFinished(connectionId: string): Promise<void>;
}

/** Tasks running at once per connection: each holds a database connection of its own. */
export const MAX_RUNNING = 6;
/** Finished results kept in memory (older ones are read from disk when opened). */
const MEMORY_RESULTS = 12;

/** The task's title: the script as one short line. */
export const titleOf = (sql: string): string => summarize(sql, 70) || "Query";

/** The line of an error message that says what is wrong: SQL Server prefixes it with "Msg 208, Level 16, State 1, Line 1". */
export function errorSummary(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  return /^Msg \d+, Level \d+/.test(first) && lines[1] ? lines[1] : first;
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 1) return `${Math.round(ms)} ms`;
  if (s < 60) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

interface Live {
  info: BackgroundTaskInfo;
  queryId: string;
  windowId: string;
  cancelled: boolean;
  result: BackgroundResult | null;
}

export function createBackground(options: BackgroundOptions): Background {
  const { host, store } = options;
  const live = new Map<string, Live>();
  let counter = 0;

  const snapshot = (info: BackgroundTaskInfo): BackgroundTaskInfo => ({ ...info, elapsedMs: info.state === "running" ? Date.now() - info.startedAt : (info.endedAt ?? info.startedAt) - info.startedAt });

  /** Keeps only the newest few finished results in memory. */
  function trimMemory() {
    const finished = [...live.values()].filter((l) => l.info.state !== "running" && l.result);
    for (const old of finished.slice(0, Math.max(0, finished.length - MEMORY_RESULTS))) old.result = null;
  }

  async function finish(job: Live, run: Awaited<ReturnType<ExecuteQuery>> | null, failure?: string): Promise<void> {
    const { info } = job;
    info.endedAt = Date.now();
    if (run) {
      const result = run as unknown as BackgroundResult;
      job.result = { resultSets: result.resultSets ?? [], messages: result.messages ?? [], rowsAffected: run.rowsAffected, database: run.database };
      info.rows = job.result.resultSets.reduce((n, s) => n + s.totalRows, 0);
      info.resultSets = job.result.resultSets.length;
      info.hasErrors = run.hasErrors;
      info.database = run.database ?? info.database;
      const firstError = errorSummary(job.result.messages.find((m) => m.kind === "error")?.text ?? "") || undefined;
      info.state = job.cancelled || run.cancelled ? "cancelled" : run.hasErrors ? "failed" : "done";
      if (info.state === "failed") info.error = firstError ?? "The script failed.";
    } else {
      info.state = job.cancelled ? "cancelled" : "failed";
      info.error = failure ?? "The query could not be run.";
    }
    info.elapsedMs = info.endedAt - info.startedAt;
    trimMemory();
    try {
      if (job.result) await store.saveResult(info.connectionId, info.id, job.result);
      await store.save(info);
    } catch {
      /* the task stays readable from memory */
    }
    void options.history
      ?.record(info.connectionId, { sql: info.sql, database: info.database, status: info.state === "cancelled" ? "cancelled" : info.state === "done" ? "ok" : "error", elapsedMs: info.elapsedMs, rows: info.rows || (job.result?.rowsAffected ?? 0), ...(info.error ? { error: info.error } : {}) })
      .catch(() => undefined);
    void options.releaseWindow?.(info.connectionId, job.windowId).catch(() => undefined);
    host.refreshExplorer(info.connectionId);
  }

  const background: Background = {
    async start({ connectionId, sql, database, title }) {
      if (!sql.trim()) throw new Error("There is nothing to run.");
      const running = [...live.values()].filter((l) => l.info.connectionId === connectionId && l.info.state === "running").length;
      if (running >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} background tasks are already running on this connection — wait for one to finish or cancel one.`);
      const id = `bg${Date.now().toString(36)}${(++counter).toString(36)}`;
      const info: BackgroundTaskInfo = { id, connectionId, title: title?.trim() || titleOf(sql), sql, database: database ?? null, state: "running", startedAt: Date.now(), elapsedMs: 0, rows: 0, resultSets: 0, hasErrors: false };
      const job: Live = { info, queryId: `${id}-q`, windowId: `bg-${id}`, cancelled: false, result: null };
      live.set(id, job);
      await store.save(info).catch(() => undefined);
      host.refreshExplorer(connectionId);

      // The app-level task: the status bar, the Tasks panel (live elapsed time, Stop), and a record of success or failure.
      host.tasks
        .run({ title: `${options.productName}: ${info.title}`, cancellable: true }, async (task) => {
          task.onCancel(() => void background.cancel(id));
          const timer = setInterval(() => task.report({ detail: `Running for ${formatElapsed(Date.now() - info.startedAt)}` }), 1000);
          try {
            let run: Awaited<ReturnType<ExecuteQuery>> | null = null;
            try {
              run = await options.executeQuery({ connectionId, windowId: job.windowId, queryId: job.queryId, database, sql });
            } catch (err) {
              await finish(job, null, options.describeError(err));
              throw new Error(info.error);
            }
            await finish(job, run);
            task.log(`${info.state === "done" ? "Finished" : info.state === "cancelled" ? "Cancelled" : "Failed"} after ${formatElapsed(info.elapsedMs)}${info.rows ? ` — ${info.rows.toLocaleString()} rows` : ""}.\n`);
            if (info.state === "failed") throw new Error(info.error);
          } finally {
            clearInterval(timer);
          }
        })
        .catch(() => undefined); // already recorded on the task; the Tasks panel shows the failure
      return snapshot(info);
    },

    async list(connectionId) {
      const stored = await store.list(connectionId).catch(() => [] as BackgroundTaskInfo[]);
      const byId = new Map(stored.map((t) => [t.id, t]));
      for (const l of live.values()) if (l.info.connectionId === connectionId) byId.set(l.info.id, l.info);
      return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt).map(snapshot);
    },

    async get(connectionId, id) {
      const l = live.get(id);
      if (l) {
        const result = l.result ?? (l.info.state === "running" ? null : await store.loadResult(connectionId, id));
        return { ...snapshot(l.info), result, serverNow: Date.now() };
      }
      const info = (await store.list(connectionId)).find((t) => t.id === id);
      if (!info) throw new Error("That background task no longer exists.");
      const result = await store.loadResult(connectionId, id);
      const cut = result?.resultSets.some((s) => s.rows.length < s.totalRows);
      return { ...snapshot(info), result, serverNow: Date.now(), ...(cut ? { keptRows: Math.max(0, ...(result?.resultSets.map((s) => s.rows.length) ?? [0])) } : {}) };
    },

    async cancel(id) {
      const job = live.get(id);
      if (!job || job.info.state !== "running") return false;
      job.cancelled = true;
      await Promise.resolve(options.cancelQuery(job.queryId)).catch(() => undefined);
      return true;
    },

    async remove(connectionId, id) {
      const job = live.get(id);
      if (job?.info.state === "running") throw new Error("Cancel the task before removing it.");
      live.delete(id);
      await store.remove(connectionId, id);
      host.refreshExplorer(connectionId);
    },

    async clearFinished(connectionId) {
      for (const [id, l] of live) if (l.info.connectionId === connectionId && l.info.state !== "running") live.delete(id);
      await store.clearFinished(connectionId);
      host.refreshExplorer(connectionId);
    },
  };
  return background;
}
