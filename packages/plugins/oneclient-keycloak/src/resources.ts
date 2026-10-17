import { type KeycloakClient, KeycloakError, idFromLocation } from "./client.js";

const enc = encodeURIComponent;

/**
 * Things you can list, open as JSON, create, update and delete. Most map 1:1 onto an admin REST collection;
 * the generic code below is what lets one JSON editor and one table view serve all of them.
 */
export type ResourceKind = "realm" | "user" | "client" | "role" | "clientRole" | "group" | "clientScope" | "identityProvider" | "flow";

/** Read-only (or special) JSON documents the editor can also open. */
export type DocumentKind = "serverInfo" | "wellKnown" | "jwks" | "installation" | "export" | "eventsConfig" | "credentials" | "serviceAccount";

export const RESOURCE_KINDS: readonly ResourceKind[] = ["realm", "user", "client", "role", "clientRole", "group", "clientScope", "identityProvider", "flow"];
export const DOCUMENT_KINDS: readonly DocumentKind[] = ["serverInfo", "wellKnown", "jwks", "installation", "export", "eventsConfig", "credentials", "serviceAccount"];

export function isResourceKind(v: unknown): v is ResourceKind {
  return typeof v === "string" && (RESOURCE_KINDS as readonly string[]).includes(v);
}
export function isDocumentKind(v: unknown): v is DocumentKind {
  return typeof v === "string" && (DOCUMENT_KINDS as readonly string[]).includes(v);
}

type Json = Record<string, unknown>;

export interface Scope {
  realm: string;
  /** Owning client (uuid) for `clientRole`; owning group (id) when creating a subgroup. */
  parent?: string | undefined;
}

interface Spec {
  /** The identifier used to address one item: users/clients/groups/scopes use their id, roles their name, idps their alias… */
  idOf(item: Json): string;
  labelOf(item: Json): string;
  readOnly?: boolean;
  /** `GET` path of the collection, relative to /admin/realms. */
  collection(s: Scope): string;
  item(s: Scope, id: string): string;
  /** Where new ones are POSTed. */
  create?(s: Scope): string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

const SPECS: Record<ResourceKind, Spec> = {
  realm: {
    idOf: (i) => str(i.realm),
    labelOf: (i) => str(i.realm),
    collection: () => "/admin/realms",
    item: (_s, id) => `/${enc(id)}`,
    create: () => "/admin/realms",
  },
  user: {
    idOf: (i) => str(i.id),
    labelOf: (i) => str(i.username),
    collection: (s) => `/${enc(s.realm)}/users`,
    item: (s, id) => `/${enc(s.realm)}/users/${enc(id)}`,
    create: (s) => `/${enc(s.realm)}/users`,
  },
  client: {
    idOf: (i) => str(i.id),
    labelOf: (i) => str(i.clientId),
    collection: (s) => `/${enc(s.realm)}/clients`,
    item: (s, id) => `/${enc(s.realm)}/clients/${enc(id)}`,
    create: (s) => `/${enc(s.realm)}/clients`,
  },
  role: {
    idOf: (i) => str(i.name),
    labelOf: (i) => str(i.name),
    collection: (s) => `/${enc(s.realm)}/roles`,
    item: (s, id) => `/${enc(s.realm)}/roles/${enc(id)}`,
    create: (s) => `/${enc(s.realm)}/roles`,
  },
  clientRole: {
    idOf: (i) => str(i.name),
    labelOf: (i) => str(i.name),
    collection: (s) => `/${enc(s.realm)}/clients/${enc(s.parent ?? "")}/roles`,
    item: (s, id) => `/${enc(s.realm)}/clients/${enc(s.parent ?? "")}/roles/${enc(id)}`,
    create: (s) => `/${enc(s.realm)}/clients/${enc(s.parent ?? "")}/roles`,
  },
  group: {
    idOf: (i) => str(i.id),
    labelOf: (i) => str(i.name),
    collection: (s) => `/${enc(s.realm)}/groups`,
    item: (s, id) => `/${enc(s.realm)}/groups/${enc(id)}`,
    create: (s) => (s.parent ? `/${enc(s.realm)}/groups/${enc(s.parent)}/children` : `/${enc(s.realm)}/groups`),
  },
  clientScope: {
    idOf: (i) => str(i.id),
    labelOf: (i) => str(i.name),
    collection: (s) => `/${enc(s.realm)}/client-scopes`,
    item: (s, id) => `/${enc(s.realm)}/client-scopes/${enc(id)}`,
    create: (s) => `/${enc(s.realm)}/client-scopes`,
  },
  identityProvider: {
    idOf: (i) => str(i.alias),
    labelOf: (i) => str(i.alias),
    collection: (s) => `/${enc(s.realm)}/identity-provider/instances`,
    item: (s, id) => `/${enc(s.realm)}/identity-provider/instances/${enc(id)}`,
    create: (s) => `/${enc(s.realm)}/identity-provider/instances`,
  },
  flow: {
    idOf: (i) => str(i.alias),
    labelOf: (i) => str(i.alias),
    readOnly: true,
    collection: (s) => `/${enc(s.realm)}/authentication/flows`,
    item: (s, id) => `/${enc(s.realm)}/authentication/flows/${enc(id)}/executions`,
  },
};

export const labelOf = (kind: ResourceKind, item: Json): string => SPECS[kind].labelOf(item);
export const idOf = (kind: ResourceKind, item: Json): string => SPECS[kind].idOf(item);
export const isReadOnly = (kind: ResourceKind): boolean => SPECS[kind].readOnly === true;

export interface ListOptions {
  search?: string | undefined;
  first?: number | undefined;
  max?: number | undefined;
}

export interface ListResult {
  items: Json[];
  hasMore: boolean;
  /** Only when Keycloak can say cheaply (users). */
  total?: number;
}

/**
 * One page of a collection. Collections Keycloak can't page or search server-side (scopes, identity providers,
 * flows, realms) are fetched whole and cut here. We ask for one more than a page so "is there a next page?" is exact.
 */
export async function listResources(client: KeycloakClient, kind: ResourceKind, scope: Scope, opts: ListOptions = {}): Promise<ListResult> {
  const spec = SPECS[kind];
  const search = opts.search?.trim() ?? "";
  const first = Math.max(0, opts.first ?? 0);
  const max = Math.min(500, Math.max(1, opts.max ?? 50));

  const serverPaged = kind === "user" || kind === "client" || kind === "role" || kind === "group";
  if (serverPaged) {
    const query: Record<string, string | number | boolean | undefined> = { first, max: max + 1 };
    if (kind === "client") Object.assign(query, { clientId: search || undefined, search: search ? true : undefined });
    else query.search = search || undefined;
    if (kind !== "client") query.briefRepresentation = true;
    const rows = await client.get<Json[]>(spec.collection(scope), query);
    const result: ListResult = { items: rows.slice(0, max), hasMore: rows.length > max };
    if (kind === "user") {
      const total = await client.get<number>(`${spec.collection(scope)}/count`, search ? { search } : {}).catch(() => undefined);
      if (typeof total === "number") result.total = total;
    }
    return result;
  }

  let all = await client.get<Json[]>(spec.collection(scope));
  if (kind === "clientRole") all = all ?? [];
  const needle = search.toLowerCase();
  const filtered = needle ? all.filter((i) => `${spec.labelOf(i)} ${str(i.description)} ${str(i.displayName)}`.toLowerCase().includes(needle)) : all;
  filtered.sort((a, b) => spec.labelOf(a).localeCompare(spec.labelOf(b), undefined, { sensitivity: "base" }));
  return { items: filtered.slice(first, first + max), hasMore: filtered.length > first + max, total: filtered.length };
}

export async function getResource(client: KeycloakClient, kind: ResourceKind, scope: Scope, id: string): Promise<unknown> {
  if (kind === "flow") {
    const flows = await client.get<Json[]>(SPECS.flow.collection(scope));
    const flow = flows.find((f) => f.alias === id);
    if (!flow) throw new KeycloakError(`Authentication flow "${id}" was not found.`, 404);
    return { ...flow, executions: await client.get(SPECS.flow.item(scope, id)) };
  }
  return client.get(SPECS[kind].item(scope, id));
}

export interface SaveResult {
  id: string;
}

/** Create (`id` omitted) or update. Returns the id of the created/updated item. */
export async function saveResource(client: KeycloakClient, kind: ResourceKind, scope: Scope, body: Json, id?: string): Promise<SaveResult> {
  const spec = SPECS[kind];
  if (spec.readOnly) throw new KeycloakError("This is read-only.");
  if (!spec.create) throw new KeycloakError(`Can't save ${kind}.`);

  if (id === undefined) {
    const res = await client.post(spec.create(scope), body);
    // Realms are addressed by name, everything else by the id in the Location header (roles/idps by name/alias in the body).
    const fromBody = spec.idOf(body);
    if (kind === "realm" || kind === "role" || kind === "clientRole" || kind === "identityProvider") return { id: fromBody || (idFromLocation(res) ?? "") };
    return { id: idFromLocation(res) ?? fromBody };
  }

  if (kind === "role" && body.id && str(body.name) !== id) {
    // Renaming a role: it's addressed by its (old) name in the URL, so go through the by-id endpoint.
    await client.put(`/${enc(scope.realm)}/roles-by-id/${enc(str(body.id))}`, body);
    return { id: str(body.name) };
  }
  await client.put(spec.item(scope, id), body);
  // A renamed realm / idp alias changes its address.
  return { id: kind === "realm" || kind === "identityProvider" ? spec.idOf(body) || id : id };
}

export async function deleteResource(client: KeycloakClient, kind: ResourceKind, scope: Scope, id: string): Promise<void> {
  if (SPECS[kind].readOnly) throw new KeycloakError("This is read-only.");
  await client.del(SPECS[kind].item(scope, id));
}

// ---- Documents -----------------------------------------------------------------------------------------------

export interface DocumentRequest {
  kind: DocumentKind;
  realm: string;
  /** Client uuid (installation, serviceAccount) or user id (credentials). */
  id?: string | undefined;
  /** Installation format, e.g. "keycloak-oidc-keycloak-json" (default), "keycloak-oidc-jboss-subsystem", "keycloak-oidc-keycloak-json". */
  provider?: string | undefined;
}

/** Read-only views and special documents; `editable` ones can be saved back with `saveDocument`. */
export async function getDocument(client: KeycloakClient, req: DocumentRequest): Promise<{ doc: unknown; editable: boolean }> {
  const realm = enc(req.realm);
  const need = () => {
    if (!req.id) throw new KeycloakError("Missing id.");
    return enc(req.id);
  };
  switch (req.kind) {
    case "serverInfo":
      return { doc: await client.get("/admin/serverinfo"), editable: false };
    case "wellKnown": {
      const res = await client.send("GET", `/realms/${realm}/.well-known/openid-configuration`);
      if (res.status !== 200) throw new KeycloakError(`Realm "${req.realm}" has no OpenID configuration (HTTP ${res.status}).`, res.status);
      return { doc: res.data, editable: false };
    }
    case "jwks": {
      const res = await client.send("GET", `/realms/${realm}/protocol/openid-connect/certs`);
      if (res.status !== 200) throw new KeycloakError(`Couldn't read the realm's public keys (HTTP ${res.status}).`, res.status);
      return { doc: res.data, editable: false };
    }
    case "installation": {
      const doc = await client.get(`/${realm}/clients/${need()}/installation/providers/${enc(req.provider ?? "keycloak-oidc-keycloak-json")}`);
      return { doc, editable: false };
    }
    case "export": {
      const res = await client.post(`/${realm}/partial-export`, undefined, { exportClients: true, exportGroupsAndRoles: true });
      return { doc: res.data, editable: false };
    }
    case "eventsConfig":
      return { doc: await client.get(`/${realm}/events/config`), editable: true };
    case "credentials":
      return { doc: await client.get(`/${realm}/users/${need()}/credentials`), editable: false };
    case "serviceAccount":
      return { doc: await client.get(`/${realm}/clients/${need()}/service-account-user`), editable: false };
  }
}

export async function saveDocument(client: KeycloakClient, req: DocumentRequest, body: unknown): Promise<void> {
  if (req.kind !== "eventsConfig") throw new KeycloakError("This document is read-only.");
  await client.put(`/${enc(req.realm)}/events/config`, body);
}
