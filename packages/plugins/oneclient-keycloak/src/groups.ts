import { type KeycloakClient, KeycloakError } from "./client.js";

const enc = encodeURIComponent;
type Json = Record<string, unknown>;

export interface GroupInfo {
  id: string;
  name: string;
  path: string;
  /** Subgroups, when Keycloak says how many (undefined = unknown, assume maybe). */
  subGroupCount?: number | undefined;
}

const toInfo = (g: Json): GroupInfo => ({
  id: String(g.id ?? ""),
  name: String(g.name ?? ""),
  path: String(g.path ?? `/${String(g.name ?? "")}`),
  ...(typeof g.subGroupCount === "number" ? { subGroupCount: g.subGroupCount } : Array.isArray(g.subGroups) ? { subGroupCount: g.subGroups.length } : {}),
});

/** Top-level groups, or the children of one group. */
export async function childGroups(client: KeycloakClient, realm: string, parentId?: string): Promise<GroupInfo[]> {
  const base = `/${enc(realm)}/groups`;
  if (!parentId) {
    return (await client.get<Json[]>(base, { first: 0, max: 1000, briefRepresentation: true })).map(toInfo);
  }
  try {
    return (await client.get<Json[]>(`${base}/${enc(parentId)}/children`, { first: 0, max: 1000, briefRepresentation: true })).map(toInfo);
  } catch (err) {
    // Keycloak before 23 has no /children endpoint: the group itself lists its subgroups.
    if (!(err instanceof KeycloakError) || err.status !== 404) throw err;
    const group = await client.get<Json>(`${base}/${enc(parentId)}`);
    return (Array.isArray(group.subGroups) ? (group.subGroups as Json[]) : []).map(toInfo);
  }
}

/** Every group in the realm, breadth-first, with its path — for pickers. Capped so a huge realm can't hang the UI. */
export async function allGroups(client: KeycloakClient, realm: string, cap = 2000): Promise<GroupInfo[]> {
  const out: GroupInfo[] = [];
  let level = await childGroups(client, realm);
  while (level.length && out.length < cap) {
    out.push(...level);
    const next: GroupInfo[] = [];
    for (const g of level) {
      if (g.subGroupCount === 0) continue;
      if (out.length + next.length >= cap) break;
      next.push(...(await childGroups(client, realm, g.id)));
    }
    level = next;
  }
  return out.slice(0, cap).sort((a, b) => a.path.localeCompare(b.path));
}
