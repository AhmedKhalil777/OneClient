import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import { type GroupInfo, childGroups } from "./groups.js";
import { requireClient } from "./sessions.js";

/** Every node type this provider produces — must match `contributes.explorerNodes` in the manifest. */
export const NODE_TYPES = [
  "keycloak.realm",
  "keycloak.tools",
  "keycloak.serverInfo",
  "keycloak.users",
  "keycloak.groups",
  "keycloak.group",
  "keycloak.roles",
  "keycloak.clients",
  "keycloak.clientScopes",
  "keycloak.identityProviders",
  "keycloak.sessions",
  "keycloak.events",
  "keycloak.adminEvents",
  "keycloak.flows",
];

interface NodeData {
  realm?: string;
  groupId?: string;
}

const TABLE = "keycloak.table";
const RESOURCE = "keycloak.resource";

/** A leaf that opens a table view (users, clients, …) on click. */
function tableLeaf(realm: string, kind: string, label: string, icon: string, nodeType: string): TreeNode {
  return {
    id: `${realm}:${kind}`,
    label,
    nodeType,
    collapsible: "none",
    icon,
    contextValue: nodeType,
    data: { realm } satisfies NodeData,
    openView: { viewId: TABLE, title: `${label} — ${realm}`, params: { kind, realm }, icon },
  };
}

function groupNode(realm: string, g: GroupInfo): TreeNode {
  return {
    id: `group:${g.id}`,
    label: g.name,
    nodeType: "keycloak.group",
    collapsible: g.subGroupCount === 0 ? "none" : "collapsed",
    icon: "$(users)",
    contextValue: "keycloak.group",
    data: { realm, groupId: g.id } satisfies NodeData,
    openView: { viewId: RESOURCE, title: `${g.name} — ${realm}`, params: { kind: "group", realm, id: g.id }, icon: "$(users)" },
  };
}

/**
 * Connection → realms → sections. Sections are leaves that open a table view; only groups expand (they nest).
 * Nothing is fetched before it's expanded.
 */
export function createExplorerProvider(): ExplorerProvider {
  return {
    nodeTypes: NODE_TYPES,

    async getChildren(node, ctx): Promise<TreeNode[]> {
      const client = requireClient(ctx.connectionId);

      if (!node) {
        const realms = (await client.get<Array<{ realm: string; displayName?: string; enabled?: boolean }>>("/admin/realms")).sort((a, b) =>
          a.realm.localeCompare(b.realm, undefined, { sensitivity: "base" }),
        );
        return [
          ...realms.map(
            (r): TreeNode => ({
              id: `realm:${r.realm}`,
              label: r.enabled === false ? `${r.realm} (disabled)` : r.realm,
              nodeType: "keycloak.realm",
              collapsible: "collapsed",
              icon: "$(cube)",
              contextValue: "keycloak.realm",
              data: { realm: r.realm } satisfies NodeData,
            }),
          ),
          {
            id: "tools",
            label: "Developer Tools",
            nodeType: "keycloak.tools",
            collapsible: "none",
            icon: "$(wrench)",
            contextValue: "keycloak.tools",
            openView: { viewId: "keycloak.tools", title: "Developer Tools", icon: "$(wrench)" },
          },
          {
            id: "serverInfo",
            label: "Server Info",
            nodeType: "keycloak.serverInfo",
            collapsible: "none",
            icon: "$(server)",
            contextValue: "keycloak.serverInfo",
            openView: { viewId: RESOURCE, title: "Server Info", params: { kind: "serverInfo", realm: "master" }, icon: "$(server)" },
          },
        ];
      }

      const data = (node.data ?? {}) as NodeData;
      const realm = data.realm ?? "";

      switch (node.nodeType) {
        case "keycloak.realm":
          return [
            tableLeaf(realm, "users", "Users", "$(user)", "keycloak.users"),
            {
              id: `${realm}:groups`,
              label: "Groups",
              nodeType: "keycloak.groups",
              collapsible: "collapsed",
              icon: "$(users)",
              contextValue: "keycloak.groups",
              data: { realm } satisfies NodeData,
            },
            tableLeaf(realm, "roles", "Roles", "$(tag)", "keycloak.roles"),
            tableLeaf(realm, "clients", "Clients", "$(window)", "keycloak.clients"),
            tableLeaf(realm, "clientScopes", "Client Scopes", "$(symbol)", "keycloak.clientScopes"),
            tableLeaf(realm, "identityProviders", "Identity Providers", "$(link)", "keycloak.identityProviders"),
            tableLeaf(realm, "sessions", "Sessions", "$(clock)", "keycloak.sessions"),
            tableLeaf(realm, "events", "Login Events", "$(bell)", "keycloak.events"),
            tableLeaf(realm, "adminEvents", "Admin Events", "$(bell)", "keycloak.adminEvents"),
            tableLeaf(realm, "flows", "Authentication Flows", "$(lock)", "keycloak.flows"),
          ];
        case "keycloak.groups":
          return (await childGroups(client, realm)).map((g) => groupNode(realm, g));
        case "keycloak.group":
          return (await childGroups(client, realm, data.groupId)).map((g) => groupNode(realm, g));
        default:
          return [];
      }
    },
  };
}
