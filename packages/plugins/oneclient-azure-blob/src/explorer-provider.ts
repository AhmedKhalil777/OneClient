import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import { listContainers, listLevel } from "./blobs.js";
import { requireSession } from "./sessions.js";

export const NODE_TYPES = ["azblob.container", "azblob.folder", "azblob.blob", "azblob.more"];

export interface NodeData {
  container?: string;
  /** Folder prefix, ending in "/" ("" = the container root). */
  prefix?: string;
  name?: string;
}

const blobNode = (container: string, name: string, label: string): TreeNode => ({
  id: `blob:${container}/${name}`,
  label,
  nodeType: "azblob.blob",
  collapsible: "none",
  icon: "$(file)",
  // Blob names usually carry an extension: the icon theme picks a file-type icon.
  resource: { name: label, kind: "file" },
  contextValue: "azblob.blob",
  data: { container, name } satisfies NodeData,
  openView: { viewId: "azblob.blob", title: label, params: { container, name } },
});

/** Account → containers → virtual folders ("/") → blobs, listed a page at a time. */
export function createExplorerProvider(): ExplorerProvider {
  return {
    nodeTypes: NODE_TYPES,
    async getChildren(node, ctx): Promise<TreeNode[]> {
      const h = requireSession(ctx.connectionId);
      if (!node) {
        return (await listContainers(h)).map(
          (c): TreeNode => ({
            id: `container:${c.name}`,
            label: c.publicAccess && c.publicAccess !== "private" ? `${c.name} (public: ${c.publicAccess})` : c.name,
            nodeType: "azblob.container",
            collapsible: "collapsed",
            icon: "$(database)",
            contextValue: "azblob.container",
            data: { container: c.name, prefix: "" } satisfies NodeData,
          }),
        );
      }
      const data = (node.data ?? {}) as NodeData;
      if (node.nodeType !== "azblob.container" && node.nodeType !== "azblob.folder") return [];
      const container = data.container ?? "";
      const prefix = data.prefix ?? "";
      const level = await listLevel(h, container, prefix, 500);
      const nodes: TreeNode[] = [
        ...level.folders.map(
          (f): TreeNode => ({
            id: `folder:${container}/${f.prefix}`,
            label: f.label,
            nodeType: "azblob.folder",
            collapsible: "collapsed",
            icon: "$(folder)",
            resource: { name: f.label, kind: "folder" },
            contextValue: "azblob.folder",
            data: { container, prefix: f.prefix } satisfies NodeData,
          }),
        ),
        ...level.blobs.filter((b) => b.label !== ".keep").map((b) => blobNode(container, b.name, b.label)),
      ];
      if (level.continuation) {
        nodes.push({
          id: `more:${container}/${prefix}`,
          label: "More… open in the browser",
          nodeType: "azblob.more",
          collapsible: "none",
          icon: "$(search)",
          contextValue: "azblob.more",
          openView: { viewId: "azblob.browser", title: `${container}/${prefix}`, params: { container, prefix }, icon: "$(database)" },
        });
      }
      return nodes;
    },
  };
}
