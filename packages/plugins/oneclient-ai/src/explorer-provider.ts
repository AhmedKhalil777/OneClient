import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import { store } from "./store.js";

const CHAT = "ai.chat";

export const NODE_TYPES = ["ai.new", "ai.conversation"];

/** Connection → “New conversation”, then the saved conversations, newest first. */
export function createExplorerProvider(): ExplorerProvider {
  return {
    nodeTypes: NODE_TYPES,
    async getChildren(node, ctx): Promise<TreeNode[]> {
      if (node) return [];
      // A fresh id each time the tree is read: the first message turns it into a saved conversation and the tree refreshes.
      const fresh = `n${Date.now().toString(36)}`;
      return [
        {
          id: "new",
          label: "New conversation",
          nodeType: "ai.new",
          collapsible: "none",
          icon: "$(add)",
          contextValue: "ai.new",
          openView: { viewId: CHAT, title: "New conversation", params: { c: fresh }, icon: "$(comment-discussion)" },
        },
        ...store.list(ctx.connectionId).map(
          (c): TreeNode => ({
            id: c.id,
            label: c.title,
            nodeType: "ai.conversation",
            collapsible: "none",
            icon: "$(comment)",
            contextValue: "ai.conversation",
            data: { conversationId: c.id },
            openView: { viewId: CHAT, title: c.title, params: { c: c.id }, icon: "$(comment)" },
          }),
        ),
      ];
    },
  };
}
