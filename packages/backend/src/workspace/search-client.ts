import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { SearchResult } from "@oneclient/plugin-api";
import type { FindOptions, FindResult, ReplaceOptions } from "./search.js";
import type { SearchRequest, SearchResponse } from "./search-worker.js";

type Payload<T> = T extends unknown ? Omit<T, "id"> : never;

/**
 * Runs workspace searches on a worker thread (out/main/search-worker.js), started on first use and restarted if it
 * dies. Requests are answered in any order, matched by id.
 */
export class SearchWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

  constructor(private readonly entry = join(__dirname, "search-worker.js")) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.entry);
    worker.on("message", (msg: SearchResponse) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
    const fail = (err: Error) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
    };
    worker.on("error", fail);
    worker.on("exit", (code) => code !== 0 && fail(new Error(`The search worker stopped (code ${code}).`)));
    // Don't keep the app alive just for an idle search thread.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private request<T>(payload: Payload<SearchRequest>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ensure().postMessage({ ...payload, id });
    });
  }

  find(root: string, options: FindOptions): Promise<FindResult> {
    return this.request({ op: "find", root, options });
  }
  replace(root: string, options: ReplaceOptions): Promise<{ filesChanged: number; replacements: number; errors: string[] }> {
    return this.request({ op: "replace", root, options });
  }
  quickOpen(folderId: string, root: string, query: string, limit: number): Promise<SearchResult[]> {
    return this.request({ op: "quickOpen", folderId, root, query, limit });
  }
  dropCache(): void {
    if (this.worker) void this.request({ op: "dropCache" }).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
  }
}
