import type { KeycloakClient } from "./client.js";
import { type GroupInfo, allGroups } from "./groups.js";

const enc = encodeURIComponent;
type Json = Record<string, unknown>;

export type Subject = "user" | "group";

export interface RoleRef {
  id: string;
  name: string;
  description?: string | undefined;
  composite?: boolean | undefined;
  clientRole?: boolean | undefined;
  containerId?: string | undefined;
}

const toRole = (r: Json): RoleRef => ({
  id: String(r.id ?? ""),
  name: String(r.name ?? ""),
  ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
  ...(typeof r.composite === "boolean" ? { composite: r.composite } : {}),
  ...(typeof r.clientRole === "boolean" ? { clientRole: r.clientRole } : {}),
  ...(typeof r.containerId === "string" ? { containerId: r.containerId } : {}),
});

const byName = (a: RoleRef, b: RoleRef) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const sorted = (rows: Json[]) => rows.map(toRole).sort(byName);

const base = (realm: string, subject: Subject, id: string) => `/${enc(realm)}/${subject === "user" ? "users" : "groups"}/${enc(id)}`;

export interface RealmMappings {
  assigned: RoleRef[];
  available: RoleRef[];
  /** Everything the subject effectively has, including via composite roles and groups. */
  effective: RoleRef[];
}

export async function realmMappings(client: KeycloakClient, realm: string, subject: Subject, id: string): Promise<RealmMappings> {
  const path = `${base(realm, subject, id)}/role-mappings/realm`;
  const [assigned, available, effective] = await Promise.all([
    client.get<Json[]>(path),
    client.get<Json[]>(`${path}/available`),
    client.get<Json[]>(`${path}/composite`),
  ]);
  return { assigned: sorted(assigned), available: sorted(available), effective: sorted(effective) };
}

export interface ClientMappingOverview {
  /** Client uuid. */
  id: string;
  clientId: string;
  assigned: RoleRef[];
}

/** Every client the subject has roles of, with those roles. */
export async function clientMappingOverview(client: KeycloakClient, realm: string, subject: Subject, id: string): Promise<ClientMappingOverview[]> {
  const all = await client.get<{ clientMappings?: Record<string, { id: string; client: string; mappings: Json[] }> }>(`${base(realm, subject, id)}/role-mappings`);
  return Object.values(all.clientMappings ?? {})
    .map((c) => ({ id: c.id, clientId: c.client, assigned: sorted(c.mappings ?? []) }))
    .sort((a, b) => a.clientId.localeCompare(b.clientId));
}

export async function clientMappings(client: KeycloakClient, realm: string, subject: Subject, id: string, clientUuid: string): Promise<{ assigned: RoleRef[]; available: RoleRef[] }> {
  const path = `${base(realm, subject, id)}/role-mappings/clients/${enc(clientUuid)}`;
  const [assigned, available] = await Promise.all([client.get<Json[]>(path), client.get<Json[]>(`${path}/available`)]);
  return { assigned: sorted(assigned), available: sorted(available) };
}

/** Add and/or remove role mappings (realm roles, or the roles of one client). */
export async function updateMappings(
  client: KeycloakClient,
  realm: string,
  subject: Subject,
  id: string,
  target: { scope: "realm" } | { scope: "client"; clientUuid: string },
  change: { add?: RoleRef[]; remove?: RoleRef[] },
): Promise<void> {
  const path = `${base(realm, subject, id)}/role-mappings/${target.scope === "realm" ? "realm" : `clients/${enc(target.clientUuid)}`}`;
  // Keycloak wants full role representations, but id + name are what it actually reads.
  const wire = (roles: RoleRef[]) => roles.map((r) => ({ id: r.id, name: r.name }));
  if (change.remove?.length) await client.del(path, wire(change.remove));
  if (change.add?.length) await client.post(path, wire(change.add));
}

// ---- Group membership (users) ------------------------------------------------------------------------------

export async function userGroups(client: KeycloakClient, realm: string, userId: string): Promise<{ member: GroupInfo[]; all: GroupInfo[] }> {
  const [member, all] = await Promise.all([client.get<Json[]>(`/${enc(realm)}/users/${enc(userId)}/groups`), allGroups(client, realm)]);
  return {
    member: member.map((g) => ({ id: String(g.id), name: String(g.name), path: String(g.path ?? `/${String(g.name)}`) })).sort((a, b) => a.path.localeCompare(b.path)),
    all,
  };
}

export async function setMembership(client: KeycloakClient, realm: string, userId: string, join: string[], leave: string[]): Promise<void> {
  for (const groupId of leave) await client.del(`/${enc(realm)}/users/${enc(userId)}/groups/${enc(groupId)}`);
  for (const groupId of join) await client.put(`/${enc(realm)}/users/${enc(userId)}/groups/${enc(groupId)}`);
}

export async function groupMembers(client: KeycloakClient, realm: string, groupId: string, first = 0, max = 100): Promise<Json[]> {
  return client.get<Json[]>(`/${enc(realm)}/groups/${enc(groupId)}/members`, { first, max, briefRepresentation: true });
}

export async function roleUsers(client: KeycloakClient, realm: string, roleName: string, clientUuid?: string): Promise<Json[]> {
  const path = clientUuid ? `/${enc(realm)}/clients/${enc(clientUuid)}/roles/${enc(roleName)}/users` : `/${enc(realm)}/roles/${enc(roleName)}/users`;
  return client.get<Json[]>(path, { first: 0, max: 200, briefRepresentation: true });
}
