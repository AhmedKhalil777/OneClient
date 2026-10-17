import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import type { Collection, Item } from "./model.js";
import { workspaceFor } from "./store.js";
import { findCollection, locate } from "./tree.js";

export const NODE_TYPES = ["http.collection", "http.folder", "http.request", "http.environments", "http.history", "http.import"];

const REQUEST = "http.request";
const WORKSPACE = "http.workspace";

interface NodeData {
  itemId?: string;
}

const METHOD_ICON = "$(play)";

function itemNode(item: Item): TreeNode {
  if (item.type === "folder") {
    return {
      id: item.id,
      label: item.name,
      nodeType: "http.folder",
      collapsible: item.items.length ? "collapsed" : "none",
      icon: "$(folder)",
      contextValue: "http.folder",
      data: { itemId: item.id } satisfies NodeData,
    };
  }
  return {
    id: item.id,
    label: `${item.request.method}  ${item.name}`,
    nodeType: "http.request",
    collapsible: "none",
    icon: METHOD_ICON,
    contextValue: "http.request",
    data: { itemId: item.id } satisfies NodeData,
    openView: { viewId: REQUEST, title: item.name, params: { id: item.id }, icon: METHOD_ICON },
  };
}

function collectionNode(c: Collection): TreeNode {
  return {
    id: c.id,
    label: c.name,
    nodeType: "http.collection",
    collapsible: c.items.length ? "collapsed" : "none",
    icon: "$(folder-opened)",
    contextValue: "http.collection",
    data: { itemId: c.id } satisfies NodeData,
  };
}

const workspaceLeaf = (id: string, label: string, icon: string, nodeType: string, tab: string): TreeNode => ({
  id,
  label,
  nodeType,
  collapsible: "none",
  icon,
  contextValue: nodeType,
  openView: { viewId: WORKSPACE, title: label, params: { tab }, icon },
});

/** Connection → collections (→ folders → requests), then Environments, History, Import. Nothing is read before it's expanded. */
export function createExplorerProvider(): ExplorerProvider {
  return {
    nodeTypes: NODE_TYPES,
    async getChildren(node, ctx): Promise<TreeNode[]> {
      const ws = workspaceFor(ctx.connectionId).get();
      if (!node) {
        return [
          ...ws.collections.map(collectionNode),
          workspaceLeaf("environments", "Environments", "$(globe)", "http.environments", "environments"),
          workspaceLeaf("history", "History", "$(clock)", "http.history", "history"),
          workspaceLeaf("import", "Import / Export", "$(add)", "http.import", "import"),
        ];
      }
      const id = (node.data as NodeData | undefined)?.itemId;
      if (!id) return [];
      if (node.nodeType === "http.collection") return (findCollection(ws, id)?.items ?? []).map(itemNode);
      if (node.nodeType === "http.folder") {
        const loc = locate(ws, id);
        return loc?.item.type === "folder" ? loc.item.items.map(itemNode) : [];
      }
      return [];
    },
  };
}
