import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import { clusterOverview, listGroups, listTopics } from "./cluster.js";
import { requireSession } from "./sessions.js";

export const NODE_TYPES = ["kafka.brokers", "kafka.broker", "kafka.topics", "kafka.topic", "kafka.groups", "kafka.group"];

export interface NodeData {
  topic?: string;
  groupId?: string;
}

export const topicView = (topic: string, tab?: string) => ({ viewId: "kafka.topic", title: topic, params: { topic, ...(tab ? { tab } : {}) }, icon: "$(list-unordered)" });
export const groupView = (groupId: string) => ({ viewId: "kafka.group", title: groupId, params: { groupId }, icon: "$(organization)" });
export const clusterView = () => ({ viewId: "kafka.cluster", title: "Kafka cluster", params: {}, icon: "$(server)" });

const folder = (nodeType: string, label: string, icon: string): TreeNode => ({ id: nodeType, label, nodeType, collapsible: "collapsed", icon, contextValue: nodeType });

/** Connection → Brokers / Topics / Consumer groups. */
export function createExplorerProvider(): ExplorerProvider {
  return {
    nodeTypes: NODE_TYPES,
    async getChildren(node, ctx): Promise<TreeNode[]> {
      const { admin } = requireSession(ctx.connectionId);
      if (!node) return [folder("kafka.brokers", "Brokers", "$(server)"), folder("kafka.topics", "Topics", "$(list-unordered)"), folder("kafka.groups", "Consumer groups", "$(organization)")];
      switch (node.nodeType) {
        case "kafka.brokers":
          return (await clusterOverview(admin)).brokers.map((b) => ({
            id: `broker:${b.nodeId}`,
            label: `${b.nodeId} — ${b.host}:${b.port}${b.controller ? " (controller)" : ""}`,
            nodeType: "kafka.broker",
            collapsible: "none",
            icon: "$(server)",
            contextValue: "kafka.broker",
            openView: clusterView(),
          }));
        case "kafka.topics":
          return (await listTopics(admin)).map((t) => ({
            id: `topic:${t.name}`,
            label: t.underReplicated ? `${t.name} (${t.underReplicated} under-replicated)` : t.name,
            nodeType: "kafka.topic",
            collapsible: "none",
            icon: "$(list-unordered)",
            contextValue: "kafka.topic",
            data: { topic: t.name } satisfies NodeData,
            openView: topicView(t.name),
          }));
        case "kafka.groups":
          return (await listGroups(admin)).map((g) => ({
            id: `group:${g.groupId}`,
            label: `${g.groupId} (${g.state.toLowerCase()})`,
            nodeType: "kafka.group",
            collapsible: "none",
            icon: "$(organization)",
            contextValue: "kafka.group",
            data: { groupId: g.groupId } satisfies NodeData,
            openView: groupView(g.groupId),
          }));
        default:
          return [];
      }
    },
  };
}
