import type { CommandHandler, TreeNode } from "@oneclient/plugin-api";
import { callApi } from "./api.js";

type Args = { connectionId: string; itemId?: string; node?: TreeNode } & Record<string, unknown>;
type Outcome = { ok: true; openNode?: TreeNode } | { ok: false; error: string };

function tab(title: string, icon: string, viewId: string, params: Record<string, string>): TreeNode {
  return { id: `${title}:${Date.now()}`, label: title, nodeType: "http.editor", collapsible: "none", openView: { viewId, title, params, icon } };
}

const itemId = (a: Args): string => {
  if (!a.itemId) throw new Error("Missing item.");
  return a.itemId;
};

async function call(a: Args, method: string, params: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  return callApi(a.connectionId, method, params);
}

/** Context-menu commands (declared with their `when` clauses in the manifest) plus the one command views use: `http.api`. */
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
      commandId: "http.api",
      async execute(args) {
        const a = (args[0] ?? {}) as { connectionId?: string; method?: string; params?: Record<string, unknown> };
        return callApi(a.connectionId, String(a.method ?? ""), a.params ?? {});
      },
    },

    on("http.newCollection", async (a) => {
      const r = await call(a, "create", { kind: "collection", name: String(a.name ?? "") });
      return r.ok ? { ok: true } : r;
    }),
    on("http.newFolder", async (a) => {
      const r = await call(a, "create", { kind: "folder", parentId: itemId(a), name: String(a.name ?? "") });
      return r.ok ? { ok: true } : r;
    }),
    on("http.newRequest", async (a) => {
      const name = String(a.name ?? "");
      const r = await call(a, "create", { kind: "request", parentId: itemId(a), name });
      if (!r.ok) return r;
      return { ok: true, openNode: tab(name, "$(play)", "http.request", { id: (r.data as { id: string }).id }) };
    }),
    on("http.rename", async (a) => {
      const r = await call(a, "rename", { id: itemId(a), name: String(a.name ?? "") });
      return r.ok ? { ok: true } : r;
    }),
    on("http.duplicate", async (a) => {
      const r = await call(a, "duplicate", { id: itemId(a) });
      return r.ok ? { ok: true } : r;
    }),
    on("http.delete", async (a) => {
      const r = await call(a, "remove", { id: itemId(a) });
      return r.ok ? { ok: true } : r;
    }),
    on("http.exportCollection", async (a) => ({ ok: true, openNode: tab("Export collection", "$(file-code)", "http.workspace", { tab: "export", id: itemId(a) }) })),
    on("http.openImport", async () => ({ ok: true, openNode: tab("Import / Export", "$(add)", "http.workspace", { tab: "import" }) })),
  ];
}
