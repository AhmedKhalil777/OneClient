import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataHome } from "../paths.js";
import type { BackgroundResult, BackgroundTaskInfo } from "./types.js";

/**
 * Background tasks on disk, per connection: `~/.oneclient/<dataDir>/background/<connection>/index.json` (the tasks, small)
 * and one `<task>.json` per finished task (its results). A task still "running" when the process starts again can't be:
 * it is marked interrupted. Only the newest MAX_TASKS are kept, and results are cut to PERSIST_ROWS rows per result set.
 */

export const MAX_TASKS = 50;
export const PERSIST_ROWS = 1000;

export interface BackgroundStore {
  list(connectionId: string): Promise<BackgroundTaskInfo[]>;
  save(task: BackgroundTaskInfo): Promise<void>;
  saveResult(connectionId: string, id: string, result: BackgroundResult): Promise<void>;
  loadResult(connectionId: string, id: string): Promise<BackgroundResult | null>;
  remove(connectionId: string, id: string): Promise<void>;
  clearFinished(connectionId: string): Promise<void>;
}

const safe = (id: string) => id.replace(/[^\w.-]+/g, "_");

export function createBackgroundStore(dataDir: string): BackgroundStore {
  const dir = (connectionId: string) => join(dataHome(), dataDir, "background", safe(connectionId));
  const index = (connectionId: string) => join(dir(connectionId), "index.json");
  /** Connections whose index was read this run: tasks left "running" by a previous run are settled once. */
  const settled = new Set<string>();
  /** Writes to one index never overlap. */
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(connectionId: string, work: () => Promise<T>): Promise<T> => {
    const next = (queues.get(connectionId) ?? Promise.resolve()).then(work, work);
    queues.set(connectionId, next.catch(() => undefined));
    return next;
  };

  async function read(connectionId: string): Promise<BackgroundTaskInfo[]> {
    let tasks: BackgroundTaskInfo[] = [];
    try {
      tasks = (JSON.parse(await readFile(index(connectionId), "utf8")) as { tasks?: BackgroundTaskInfo[] }).tasks ?? [];
    } catch {
      /* none yet, or unreadable: start over */
    }
    if (!settled.has(connectionId)) {
      settled.add(connectionId);
      let changed = false;
      for (const t of tasks) {
        if (t.state === "running") {
          t.state = "interrupted";
          t.error = "oneClient was closed while this was running.";
          changed = true;
        }
      }
      if (changed) await write(connectionId, tasks);
    }
    return tasks;
  }

  async function write(connectionId: string, tasks: BackgroundTaskInfo[]): Promise<void> {
    await mkdir(dir(connectionId), { recursive: true });
    const kept = [...tasks].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_TASKS);
    for (const dropped of tasks.filter((t) => !kept.includes(t))) await rm(join(dir(connectionId), `${safe(dropped.id)}.json`), { force: true });
    const file = index(connectionId);
    await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, tasks: kept }), "utf8");
    await rename(`${file}.tmp`, file);
  }

  return {
    list: (connectionId) => serial(connectionId, () => read(connectionId)),

    save: (task) =>
      serial(task.connectionId, async () => {
        const tasks = await read(task.connectionId);
        const i = tasks.findIndex((t) => t.id === task.id);
        if (i >= 0) tasks[i] = task;
        else tasks.push(task);
        await write(task.connectionId, tasks);
      }),

    async saveResult(connectionId, id, result) {
      await mkdir(dir(connectionId), { recursive: true });
      const cut: BackgroundResult = { ...result, resultSets: result.resultSets.map((s) => ({ ...s, rows: s.rows.slice(0, PERSIST_ROWS) })) };
      const file = join(dir(connectionId), `${safe(id)}.json`);
      await writeFile(`${file}.tmp`, JSON.stringify(cut), "utf8");
      await rename(`${file}.tmp`, file);
    },

    async loadResult(connectionId, id) {
      try {
        return JSON.parse(await readFile(join(dir(connectionId), `${safe(id)}.json`), "utf8")) as BackgroundResult;
      } catch {
        return null;
      }
    },

    remove: (connectionId, id) =>
      serial(connectionId, async () => {
        await write(connectionId, (await read(connectionId)).filter((t) => t.id !== id));
        await rm(join(dir(connectionId), `${safe(id)}.json`), { force: true });
      }),

    clearFinished: (connectionId) =>
      serial(connectionId, async () => {
        const tasks = await read(connectionId);
        for (const t of tasks.filter((x) => x.state !== "running")) await rm(join(dir(connectionId), `${safe(t.id)}.json`), { force: true });
        await write(connectionId, tasks.filter((t) => t.state === "running"));
      }),
  };
}
