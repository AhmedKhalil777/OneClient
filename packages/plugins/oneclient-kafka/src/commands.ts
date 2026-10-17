import type { CommandHandler, SearchResult, TreeNode } from "@oneclient/plugin-api";
import { callApi } from "./api.js";
import { listGroups, listTopics } from "./cluster.js";
import { clusterView, groupView, topicView } from "./explorer-provider.js";
import { requireSession } from "./sessions.js";

type Args = { connectionId: string; topic?: string; groupId?: string; node?: TreeNode } & Record<string, unknown>;
type Outcome = { ok: true; openNode?: TreeNode } | { ok: false; error: string };

const tab = (view: TreeNode["openView"] & object): TreeNode => ({ id: `tab:${view.viewId}:${view.title}:${Date.now()}`, label: view.title ?? "", nodeType: "kafka.topic", collapsible: "none", openView: view });
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
      commandId: "kafka.api",
      async execute(args) {
        const a = (args[0] ?? {}) as { connectionId?: string; method?: string; params?: Record<string, unknown> };
        return callApi(a.connectionId, String(a.method ?? ""), a.params ?? {});
      },
    },
    {
      // Global search provider: topics and consumer groups whose name contains the query.
      commandId: "kafka.search",
      async execute(args): Promise<SearchResult[]> {
        const { connectionId, query, limit = 20 } = (args[0] ?? {}) as { connectionId: string; query: string; limit?: number };
        const { admin } = requireSession(connectionId);
        const q = String(query).trim().toLowerCase();
        const rank = (name: string) => (name.toLowerCase().startsWith(q) ? 0 : 1);
        const topics = (await listTopics(admin)).filter((t) => t.name.toLowerCase().includes(q)).sort((a, b) => rank(a.name) - rank(b.name));
        const groups = (await listGroups(admin).catch(() => [])).filter((g) => g.groupId.toLowerCase().includes(q)).sort((a, b) => rank(a.groupId) - rank(b.groupId));
        return [
          ...topics.map((t): SearchResult => ({ id: `topic:${t.name}`, label: t.name, description: `topic · ${t.partitions} partition(s)`, icon: "$(list-unordered)", openView: topicView(t.name) })),
          ...groups.map((g): SearchResult => ({ id: `group:${g.groupId}`, label: g.groupId, description: `consumer group · ${g.state}`, icon: "$(organization)", openView: groupView(g.groupId) })),
        ].slice(0, limit);
      },
    },
    on("kafka.openCluster", async () => ({ ok: true, openNode: tab(clusterView()) })),
    on("kafka.createTopic", async (a) => {
      const name = String(a.topicName ?? "").trim();
      const r = await callApi(a.connectionId, "createTopic", { name, partitions: Number(a.partitions ?? 1), replicationFactor: Number(a.replicationFactor ?? 1) });
      return r.ok ? { ok: true, openNode: tab(topicView(name)) } : fail(r);
    }),
    on("kafka.produce", async (a) => ({ ok: true, openNode: tab(topicView(String(a.topic ?? ""), "produce")) })),
    on("kafka.browse", async (a) => ({ ok: true, openNode: tab(topicView(String(a.topic ?? ""), "messages")) })),
    on("kafka.addPartitions", async (a) => fail(await callApi(a.connectionId, "addPartitions", { topic: String(a.topic ?? ""), count: Number(a.count ?? 0) }))),
    on("kafka.emptyTopic", async (a) => fail(await callApi(a.connectionId, "emptyTopic", { topic: String(a.topic ?? "") }))),
    on("kafka.deleteTopic", async (a) => fail(await callApi(a.connectionId, "deleteTopic", { topic: String(a.topic ?? "") }))),
    on("kafka.deleteGroup", async (a) => fail(await callApi(a.connectionId, "deleteGroup", { groupId: String(a.groupId ?? "") }))),
  ];
}
