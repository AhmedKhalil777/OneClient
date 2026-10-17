import type { CommandHandler, SearchResult, TreeNode } from "@oneclient/plugin-api";
import { callApi } from "./api.js";
import { listContainers, listFlat } from "./blobs.js";
import { requireSession } from "./sessions.js";

type Args = { connectionId: string; container?: string; prefix?: string; name?: string; node?: TreeNode } & Record<string, unknown>;
type Outcome = { ok: true; openNode?: TreeNode } | { ok: false; error: string };

const browserTab = (container: string, prefix: string): TreeNode => ({
  id: `browser:${container}/${prefix}:${Date.now()}`,
  label: container,
  nodeType: "azblob.editor",
  collapsible: "none",
  openView: { viewId: "azblob.browser", title: prefix ? `${container}/${prefix}` : container, params: { container, prefix }, icon: "$(database)" },
});

const fail = (r: { ok: boolean; error?: string }): Outcome => (r.ok ? { ok: true } : { ok: false, error: r.error ?? "Failed." });

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
      commandId: "azblob.api",
      async execute(args) {
        const a = (args[0] ?? {}) as { connectionId?: string; method?: string; params?: Record<string, unknown> };
        return callApi(a.connectionId, String(a.method ?? ""), a.params ?? {});
      },
    },
    {
      // Global search provider: containers whose name contains the query, and blobs whose name starts with it.
      commandId: "azblob.search",
      async execute(args): Promise<SearchResult[]> {
        const { connectionId, query, limit = 20 } = (args[0] ?? {}) as { connectionId: string; query: string; limit?: number };
        const h = requireSession(connectionId);
        const q = String(query).trim();
        const containers = await listContainers(h);
        const out: SearchResult[] = containers
          .filter((c) => c.name.includes(q.toLowerCase()))
          .slice(0, 5)
          .map((c) => ({ label: c.name, description: "container", icon: "$(database)", openView: { viewId: "azblob.browser", title: c.name, params: { container: c.name, prefix: "" }, icon: "$(database)" } }));
        // Blob listing only filters by prefix: try the query as a path prefix in each container.
        for (const c of containers.slice(0, 20)) {
          if (out.length >= limit) break;
          for (const name of await listFlat(h, c.name, q, limit - out.length).catch(() => [] as string[])) {
            const label = name.slice(name.lastIndexOf("/") + 1) || name;
            out.push({ id: `blob:${c.name}/${name}`, label, description: `${c.name}/${name}`, icon: "$(file)", resource: { name: label, kind: "file" }, openView: { viewId: "azblob.blob", title: label, params: { container: c.name, name } } });
          }
        }
        return out.slice(0, limit);
      },
    },
    on("azblob.createContainer", async (a) => fail(await callApi(a.connectionId, "createContainer", { name: String(a.containerName ?? ""), access: String(a.access ?? "private") }))),
    on("azblob.deleteContainer", async (a) => fail(await callApi(a.connectionId, "deleteContainer", { container: String(a.container ?? "") }))),
    on("azblob.setAccess", async (a) => fail(await callApi(a.connectionId, "setAccess", { container: String(a.container ?? ""), access: String(a.access ?? "private") }))),
    on("azblob.newFolder", async (a) => fail(await callApi(a.connectionId, "createFolder", { container: String(a.container ?? ""), prefix: a.prefix ?? "", name: String(a.folderName ?? "") }))),
    on("azblob.openBrowser", async (a) => ({ ok: true, openNode: browserTab(String(a.container ?? ""), String(a.prefix ?? "")) })),
    on("azblob.deleteFolder", async (a) => fail(await callApi(a.connectionId, "deletePrefix", { container: String(a.container ?? ""), prefix: String(a.prefix ?? "") }))),
    on("azblob.deleteBlob", async (a) => fail(await callApi(a.connectionId, "delete", { container: String(a.container ?? ""), names: [String(a.name ?? "")] }))),
    on("azblob.downloadBlob", async (a) => {
      const r = await callApi(a.connectionId, "download", { container: String(a.container ?? ""), name: String(a.name ?? "") });
      return r.ok ? { ok: true } : fail(r);
    }),
  ];
}
