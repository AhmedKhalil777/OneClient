import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import type { Infrastructure } from "./infra.js";
import { requireSession } from "./sessions.js";
import { templateKey } from "./templates.js";

const ROOT_NODE_TYPES = ["docker.containers", "docker.images", "docker.volumes", "docker.networks", "docker.templates"];

/**
 * Registry icons. "folder" is core's; the docker-* ids are registered by this plugin
 * (contributes.icons) so other plugins and icon themes can use/restyle them too.
 */
const ICON = {
  folder: "$(folder)",
  container: "$(docker-container)",
  image: "$(docker-image)",
  volume: "$(docker-volume)",
  network: "$(docker-network)",
};

export function createExplorerProvider(infra: Infrastructure): ExplorerProvider {
  return {
    nodeTypes: [...ROOT_NODE_TYPES, "docker.container", "docker.image", "docker.volume", "docker.network", "docker.template"],

    async getChildren(node, ctx): Promise<TreeNode[]> {
      const client = requireSession(ctx.connectionId);

      if (!node) {
        return [
          { id: "containers", label: "Containers", nodeType: "docker.containers", collapsible: "collapsed", icon: ICON.folder },
          { id: "images", label: "Images", nodeType: "docker.images", collapsible: "collapsed", icon: ICON.folder },
          { id: "volumes", label: "Volumes", nodeType: "docker.volumes", collapsible: "collapsed", icon: ICON.folder },
          { id: "networks", label: "Networks", nodeType: "docker.networks", collapsible: "collapsed", icon: ICON.folder },
          {
            id: "templates",
            label: "Templates",
            description: "run & connect",
            tooltip: "Start a database, broker or cache your plugins support, and get a ready connection to it",
            nodeType: "docker.templates",
            collapsible: "collapsed",
            icon: ICON.folder,
          },
        ];
      }

      switch (node.nodeType) {
        case "docker.containers": {
          const containers = await client.listContainers({ all: true });
          // Which plugin each container belongs to, and whether a saved connection points at it.
          const owners = await infra.annotate(containers).catch(() => new Map());
          return containers.map((c) => {
            const name = (c.Names[0] ?? c.Id).replace(/^\//, "");
            const running = c.State === "running";
            const owner = owners.get(c.Id);
            let description = c.State;
            let contextValue = running ? "docker.container.running" : "docker.container.stopped";
            let tooltip = `${name}\n${c.Image} — ${c.Status}`;
            if (owner) {
              const product = owner.template.product ?? owner.template.title;
              const linked = owner.connections.map((x: { name: string }) => x.name);
              description = `${c.State} · ${product}${linked.length ? ` → ${linked.join(", ")}` : ""}`;
              // "attached": a connection points at it; "detached": a plugin could connect, but nothing does yet.
              contextValue += linked.length ? ".attached" : ".detached";
              tooltip += linked.length ? `\n${product} connection: ${linked.join(", ")}` : `\n${product} — no connection yet (right-click → Create Connection)`;
            }
            return {
              id: c.Id,
              label: name,
              description,
              tooltip,
              nodeType: "docker.container",
              collapsible: "none",
              icon: owner?.template.icon || ICON.container,
              contextValue,
              data: { containerId: c.Id },
            } satisfies TreeNode;
          });
        }
        case "docker.templates": {
          const templates = await infra.templates();
          return templates.map((t) => ({
            id: templateKey(t),
            label: t.title,
            description: t.image,
            tooltip: `${t.title}\n${t.description ?? ""}\nClick to run it and create a ${t.product ?? t.title} connection.`.trim(),
            nodeType: "docker.template",
            collapsible: "none",
            icon: t.icon || ICON.image,
            contextValue: "docker.template",
            data: { template: templateKey(t) },
            openView: { viewId: "docker.dashboard", title: `Run ${t.title}`, icon: t.icon || ICON.image, params: { tab: "templates", template: templateKey(t) } },
          }));
        }
        case "docker.images": {
          const images = await client.listImages();
          return images.map((img) => ({
            id: img.Id,
            label: img.RepoTags?.[0] ?? img.Id.replace("sha256:", "").slice(0, 12),
            nodeType: "docker.image",
            collapsible: "none",
            icon: ICON.image,
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
            icon: ICON.volume,
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
            icon: ICON.network,
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
