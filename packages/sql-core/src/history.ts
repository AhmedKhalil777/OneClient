import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataHome } from "./paths.js";

/**
 * Query history per connection: every script run from a query window, newest last, in
 * `~/.oneclient/<dataDir>/history/<connectionId>.jsonl` (or under `$ONECLIENT_HOME`). Append-only JSON lines, trimmed to
 * the newest MAX_ENTRIES now and then, so a crash never loses more than the line being written.
 */

const MAX_ENTRIES = 1000;
const MAX_SQL = 100_000;

export interface HistoryEntry {
  id: string;
  at: number;
  sql: string;
  database: string | null;
  status: "ok" | "error" | "cancelled";
  elapsedMs: number;
  rows: number;
  error?: string;
}

export interface HistoryStore {
  record(connectionId: string, entry: Omit<HistoryEntry, "id" | "at">): Promise<void>;
  /** Newest first; `search` matches the SQL or database (case-insensitive, all words). */
  list(connectionId: string, opts?: { search?: string; limit?: number }): Promise<HistoryEntry[]>;
  get(connectionId: string, id: string): Promise<HistoryEntry | undefined>;
  /** One entry, or (without `id`) the connection's whole history. */
  remove(connectionId: string, id?: string): Promise<void>;
}

export function createHistoryStore(dataDir: string): HistoryStore {
  const file = (connectionId: string) => join(dataHome(), dataDir, "history", `${connectionId.replace(/[^\w.-]+/g, "_")}.jsonl`);

  async function load(connectionId: string): Promise<HistoryEntry[]> {
    let text: string;
    try {
      text = await readFile(file(connectionId), "utf8");
    } catch {
      return [];
    }
    const out: HistoryEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as HistoryEntry);
      } catch {
        // a torn last line: skip it
      }
    }
    return out;
  }

  const appends = new Map<string, number>();

  return {
    async record(connectionId, entry) {
      const sql = entry.sql.trim();
      if (!sql) return;
      const full: HistoryEntry = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), ...entry, sql: sql.length > MAX_SQL ? sql.slice(0, MAX_SQL) : sql };
      const path = file(connectionId);
      await mkdir(join(path, ".."), { recursive: true });
      await appendFile(path, `${JSON.stringify(full)}\n`, "utf8");
      // Trim every 100 appends (and the first time in a session) rather than on every run.
      const n = (appends.get(connectionId) ?? 0) + 1;
      appends.set(connectionId, n);
      if (n % 100 === 1) {
        const all = await load(connectionId);
        if (all.length > MAX_ENTRIES) await writeFile(path, all.slice(-MAX_ENTRIES).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      }
    },

    async list(connectionId, opts = {}) {
      const words = (opts.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const all = (await load(connectionId)).reverse();
      const hits = words.length ? all.filter((e) => words.every((w) => e.sql.toLowerCase().includes(w) || (e.database ?? "").toLowerCase().includes(w))) : all;
      return hits.slice(0, opts.limit ?? 200);
    },

    async get(connectionId, id) {
      return (await load(connectionId)).find((e) => e.id === id);
    },

    async remove(connectionId, id) {
      if (!id) {
        await rm(file(connectionId), { force: true });
        return;
      }
      const all = await load(connectionId);
      await writeFile(file(connectionId), all.filter((e) => e.id !== id).map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
    },
  };
}
