import type { CommandHandler, SearchResult, TreeNode } from "@oneclient/plugin-api";
import { callApi } from "./api.js";
import { TYPE_ICON } from "./explorer-provider.js";
import { databases } from "./server.js";
import { scanKeys } from "./keys.js";
import { clientFor, sessionConfig } from "./sessions.js";

type Args = { connectionId: string; db?: number; prefix?: string; key?: string; node?: TreeNode } & Record<string, unknown>;
type Outcome = { ok: true; openNode?: TreeNode } | { ok: false; error: string };

const tab = (viewId: string, title: string, params: Record<string, string>, icon: string): TreeNode => ({
  id: `${viewId}:${title}:${Date.now()}`,
  label: title,
  nodeType: "redis.editor",
  collapsible: "none",
  openView: { viewId, title, params, icon },
});

const fail = (r: { ok: boolean; error?: string }): Outcome => (r.ok ? { ok: true } : { ok: false, error: r.error ?? "Failed." });

/** Context-menu commands (declared with their `when` in the manifest), the view API, and the search provider. */
export function createCommandHandlers(): CommandHandler[] {
  const on = (commandId: string, fn: (a: Args) => Promise<Outcome>): CommandHandler => ({
    commandId,
    execute: async (args) => {
      try {
        return await fn((args[0] ?? {}) as Args);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Outcome;
      }
    },
  });

  return [
    {
      commandId: "redis.api",
      async execute(args) {
        const a = (args[0] ?? {}) as { connectionId?: string; method?: string; params?: Record<string, unknown> };
        return callApi(a.connectionId, String(a.method ?? ""), a.params ?? {});
      },
    },
    {
      // Global search provider: key names containing the query, in every database that has keys.
      commandId: "redis.search",
      async execute(args): Promise<SearchResult[]> {
        const { connectionId, query, limit = 20 } = (args[0] ?? {}) as { connectionId: string; query: string; limit?: number };
        const cfg = sessionConfig(connectionId);
        const { list } = await databases(await clientFor(connectionId, cfg.database ?? 0), cfg.database ?? 0);
        const pattern = `*${String(query).replace(/[*?[\]\\]/g, (c) => `\\${c}`)}*`;
        const out: SearchResult[] = [];
        for (const d of list.filter((x) => x.keys > 0)) {
          if (out.length >= limit) break;
          const page = await scanKeys(await clientFor(connectionId, d.index), { match: pattern, limit: limit - out.length });
          for (const k of page.keys) {
            out.push({
              id: `key:${d.index}:${k.name}`,
              label: k.name,
              description: `${k.type} · db${d.index}`,
              icon: TYPE_ICON[k.type] ?? "$(key)",
              openView: { viewId: "redis.key", title: k.name, params: { db: String(d.index), key: k.name }, icon: TYPE_ICON[k.type] ?? "$(key)" },
            });
          }
        }
        return out;
      },
    },
    on("redis.newKey", async (a) => {
      const db = Number(a.db ?? 0);
      const key = `${a.prefix ?? ""}${String(a.name ?? "")}`;
      const r = await callApi(a.connectionId, "create", { db, key, type: String(a.type ?? "string"), value: String(a.value ?? "") });
      if (!r.ok) return fail(r);
      return { ok: true, openNode: tab("redis.key", key, { db: String(db), key }, TYPE_ICON[String(a.type)] ?? "$(key)") };
    }),
    on("redis.deleteKey", async (a) => fail(await callApi(a.connectionId, "delete", { db: a.db ?? 0, key: String(a.key ?? "") }))),
    on("redis.deleteNamespace", async (a) => fail(await callApi(a.connectionId, "deletePrefix", { db: a.db ?? 0, prefix: String(a.prefix ?? "") }))),
    on("redis.flushDb", async (a) => fail(await callApi(a.connectionId, "flushDb", { db: a.db ?? 0 }))),
    on("redis.openBrowser", async (a) => {
      const db = Number(a.db ?? 0);
      return { ok: true, openNode: tab("redis.browser", `Keys — db${db}`, { db: String(db), match: a.prefix ? `${a.prefix}*` : "*" }, "$(search)") };
    }),
    on("redis.openCli", async (a) => {
      const db = Number(a.db ?? 0);
      return { ok: true, openNode: tab("redis.browser", `CLI — db${db}`, { db: String(db), tab: "cli" }, "$(terminal)") };
    }),
  ];
}
