import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import { namespaceLevel } from "./keys.js";
import { databases } from "./server.js";
import { clientFor, sessionConfig } from "./sessions.js";

export const NODE_TYPES = ["redis.database", "redis.namespace", "redis.key", "redis.more"];

export interface NodeData {
  db?: number;
  /** Namespace prefix ("user:1001:"); "" = the whole database. */
  prefix?: string;
  key?: string;
}

/** One icon per Redis type, from the shared icon registry. */
export const TYPE_ICON: Record<string, string> = {
  string: "$(symbol)",
  hash: "$(table)",
  list: "$(results)",
  set: "$(extensions)",
  zset: "$(index)",
  stream: "$(output)",
  "ReJSON-RL": "$(file-code)",
};

const keyNode = (db: number, name: string, label: string, type: string): TreeNode => ({
  id: `key:${db}:${name}`,
  label,
  nodeType: "redis.key",
  collapsible: "none",
  icon: TYPE_ICON[type] ?? "$(key)",
  contextValue: "redis.key",
  data: { db, key: name } satisfies NodeData,
  openView: { viewId: "redis.key", title: name, params: { db: String(db), key: name }, icon: TYPE_ICON[type] ?? "$(key)" },
});

async function level(connectionId: string, db: number, prefix: string): Promise<TreeNode[]> {
  const client = await clientFor(connectionId, db);
  const lv = await namespaceLevel(client, prefix);
  const nodes: TreeNode[] = [
    ...lv.folders.map(
      (f): TreeNode => ({
        id: `ns:${db}:${f.prefix}`,
        label: `${f.name} (${f.count})`,
        nodeType: "redis.namespace",
        collapsible: "collapsed",
        icon: "$(folder)",
        contextValue: "redis.namespace",
        data: { db, prefix: f.prefix } satisfies NodeData,
      }),
    ),
    ...lv.keys.map((k) => keyNode(db, k.name, k.label, k.type)),
  ];
  if (lv.truncated) {
    nodes.push({
      id: `more:${db}:${prefix}`,
      label: "More keys… open the key browser",
      nodeType: "redis.more",
      collapsible: "none",
      icon: "$(search)",
      contextValue: "redis.more",
      data: { db, prefix } satisfies NodeData,
      openView: { viewId: "redis.browser", title: `Keys — db${db}`, params: { db: String(db), match: `${prefix}*` }, icon: "$(search)" },
    });
  }
  return nodes;
}

/** Connection → databases (with key counts) → namespaces (keys split on ":") → keys. Nothing is scanned before it's expanded. */
export function createExplorerProvider(): ExplorerProvider {
  return {
    nodeTypes: NODE_TYPES,
    async getChildren(node, ctx): Promise<TreeNode[]> {
      if (!node) {
        const cfg = sessionConfig(ctx.connectionId);
        const { list } = await databases(await clientFor(ctx.connectionId, cfg.database ?? 0), cfg.database ?? 0);
        return list.map(
          (d): TreeNode => ({
            id: `db:${d.index}`,
            label: `db${d.index} (${d.keys.toLocaleString()} key${d.keys === 1 ? "" : "s"})`,
            nodeType: "redis.database",
            collapsible: d.keys > 0 ? "collapsed" : "none",
            icon: "$(database)",
            contextValue: "redis.database",
            data: { db: d.index, prefix: "" } satisfies NodeData,
          }),
        );
      }
      const data = (node.data ?? {}) as NodeData;
      if (node.nodeType === "redis.database" || node.nodeType === "redis.namespace") return level(ctx.connectionId, data.db ?? 0, data.prefix ?? "");
      return [];
    },
  };
}
