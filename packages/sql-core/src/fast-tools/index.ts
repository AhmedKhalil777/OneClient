import type { TreeNode } from "@oneclient/plugin-api";
import type { FolderStore } from "./folder.js";

/**
 * FAST TOOLS — the sidebar section of reusable developer tools for a SQL connection. Every tool keeps its files in
 * the connection's Fast Tools folder and shows up there as a folder of its own:
 *
 *   FAST TOOLS
 *   └ <connection>                 <prefix>.fastToolsRoot
 *     ├ C:\repo\db                 the attached folder (attach / detach)
 *     ├ Fast Queries               *.query.sql — saved scripts, run on a database in one click   (core, every dialect)
 *     └ Fakers                     *.faker.json — fake data generators                           (SQL Server's own tool)
 *
 * The core brings the tools every dialect gets; a plugin adds its own through `SqlCoreOptions.tools`.
 */
export interface FastTool {
  id: string;
  label: string;
  icon: string;
  /** Node type of the tool's folder under each connection. */
  rootNodeType: string;
  /** Every node type below the root that has children (the explorer provider routes them here). */
  nodeTypes: string[];
  children(connectionId: string, folder: string, node: TreeNode): Promise<TreeNode[]>;
}

export interface FastToolsSection {
  rootNodeType: string;
  /** Node types the explorer provider must route to `nodes` (list them in its `nodeTypes`). */
  nodeTypes: string[];
  handles(nodeType: string): boolean;
  nodes(connectionId: string, node: TreeNode): Promise<TreeNode[]>;
}

export function createFastToolsSection(prefix: string, folders: FolderStore, tools: FastTool[]): FastToolsSection {
  const rootNodeType = `${prefix}.fastToolsRoot`;
  const nodeTypes = [rootNodeType, ...tools.flatMap((t) => [t.rootNodeType, ...t.nodeTypes])];
  return {
    rootNodeType,
    nodeTypes,
    handles: (nodeType) => nodeTypes.includes(nodeType),
    async nodes(connectionId, node) {
      const folder = folders.get(connectionId);
      if (node.nodeType === rootNodeType) {
        if (!folder) {
          return [{ id: "fast:none", label: "No folder attached — right-click to attach one", nodeType: `${prefix}.fastToolsHint`, collapsible: "none", icon: "$(folder)", contextValue: rootNodeType }];
        }
        return [
          { id: "fast:folder", label: folder, nodeType: `${prefix}.fastToolsFolder`, collapsible: "none", icon: "$(folder-opened)", tooltip: "Fast Tools folder of this connection", contextValue: `${prefix}.fastToolsFolder` },
          ...tools.map((t): TreeNode => ({ id: `fast:${t.id}`, label: t.label, nodeType: t.rootNodeType, collapsible: "expanded", icon: t.icon, contextValue: t.rootNodeType })),
        ];
      }
      if (!folder) return [];
      const tool = tools.find((t) => t.rootNodeType === node.nodeType || t.nodeTypes.includes(node.nodeType));
      return tool ? tool.children(connectionId, folder, node) : [];
    },
  };
}
