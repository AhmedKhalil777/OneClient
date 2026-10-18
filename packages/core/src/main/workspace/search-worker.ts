import { parentPort } from "node:worker_threads";
import { dropSearchCache, findInFiles, quickOpen, replaceInFiles } from "./search.js";

/**
 * Worker thread for the workspace's text search: walking a folder, reading thousands of files and running the regex
 * over them is CPU-heavy, and in the main process it would freeze every window. Requests come from SearchWorker.
 */

export type SearchRequest =
  | { id: number; op: "find"; root: string; options: Parameters<typeof findInFiles>[1] }
  | { id: number; op: "replace"; root: string; options: Parameters<typeof replaceInFiles>[1] }
  | { id: number; op: "quickOpen"; root: string; folderId: string; query: string; limit: number }
  | { id: number; op: "dropCache" };

export type SearchResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

parentPort?.on("message", (msg: SearchRequest) => {
  void (async () => {
    try {
      let result: unknown;
      if (msg.op === "find") result = await findInFiles(msg.root, msg.options);
      else if (msg.op === "replace") result = await replaceInFiles(msg.root, msg.options);
      else if (msg.op === "quickOpen") result = await quickOpen(msg.folderId, msg.root, msg.query, msg.limit);
      else dropSearchCache();
      parentPort?.postMessage({ id: msg.id, ok: true, result } satisfies SearchResponse);
    } catch (err) {
      parentPort?.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies SearchResponse);
    }
  })();
});
