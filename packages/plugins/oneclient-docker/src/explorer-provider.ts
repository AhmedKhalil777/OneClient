import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import { requireSession } from "./sessions.js";

const ROOT_NODE_TYPES = ["docker.containers", "docker.images", "docker.volumes", "docker.networks"];

export function createExplorerProvider(): ExplorerProvider {
  return {
    nodeTypes: [...ROOT_NODE_TYPES, "docker.container", "docker.image", "docker.volume", "docker.network"],

    async getChildren(node, ctx): Promise<TreeNode[]> {
      const client = requireSession(ctx.connectionId);

      if (!node) {
        return [
          { id: "containers", label: "Containers", nodeType: "docker.containers", collapsible: "collapsed" },
          { id: "images", label: "Images", nodeType: "docker.images", collapsible: "collapsed" },
          { id: "volumes", label: "Volumes", nodeType: "docker.volumes", collapsible: "collapsed" },
          { id: "networks", label: "Networks", nodeType: "docker.networks", collapsible: "collapsed" },
        ];
      }

      switch (node.nodeType) {
        case "docker.containers": {
          const containers = await client.listContainers({ all: true });
          return containers.map((c) => ({
            id: c.Id,
            label: `${(c.Names[0] ?? c.Id).replace(/^\//, "")}  (${c.State})`,
            nodeType: "docker.container",
            collapsible: "none",
            contextValue: c.State === "running" ? "docker.container.running" : "docker.container.stopped",
            data: { containerId: c.Id },
          }));
        }
        case "docker.images": {
          const images = await client.listImages();
          return images.map((img) => ({
            id: img.Id,
            label: img.RepoTags?.[0] ?? img.Id.replace("sha256:", "").slice(0, 12),
            nodeType: "docker.image",
            collapsible: "none",
            contextValue: "docker.image",
            data: { imageId: img.Id },
          }));
        }
        case "docker.volumes": {
          const { Volumes } = await client.listVolumes();
          return (Volumes ?? []).map((v) => ({
            id: v.Name,
            label: v.Name,
            nodeType: "docker.volume",
            collapsible: "none",
            contextValue: "docker.volume",
            data: { name: v.Name },
          }));
        }
        case "docker.networks": {
          const networks = await client.listNetworks();
          return networks.map((n) => ({
            id: n.Id ?? n.Name ?? "unknown",
            label: n.Name ?? n.Id ?? "(unnamed)",
            nodeType: "docker.network",
            collapsible: "none",
            contextValue: "docker.network",
            data: { networkId: n.Id },
          }));
        }
        default:
          return [];
      }
    },
  };
}
