import { type KeycloakClient, KeycloakError } from "./client.js";
import { withOp } from "./log.js";
import { clientSessions, deleteSession, listEvents, sessionStats, userSessions } from "./activity.js";
import { allGroups, childGroups } from "./groups.js";
import { type RoleRef, type Subject, clientMappingOverview, clientMappings, groupMembers, realmMappings, roleUsers, setMembership, updateMappings, userGroups } from "./mappings.js";
import {
  type DocumentKind,
  type ResourceKind,
  type Scope,
  deleteResource,
  getDocument,
  getResource,
  isDocumentKind,
  isReadOnly,
  isResourceKind,
  listResources,
  saveDocument,
  saveResource,
} from "./resources.js";
import { type ExampleKind, type Grant, exampleToken, introspectToken, requestToken, userInfo } from "./tokens.js";

const enc = encodeURIComponent;
type Json = Record<string, unknown>;
type Params = Record<string, unknown>;
export type Handler = (client: KeycloakClient, p: Params) => Promise<unknown>;

// ---- parameter helpers -------------------------------------------------------------------------------------------

function needS(p: Params, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v === "") throw new KeycloakError(`Missing "${key}".`);
  return v;
}
const optS = (p: Params, key: string): string | undefined => (typeof p[key] === "string" && p[key] !== "" ? (p[key] as string) : undefined);
const optN = (p: Params, key: string): number | undefined => (typeof p[key] === "number" ? (p[key] as number) : undefined);
const kindOf = (p: Params): ResourceKind => {
  if (!isResourceKind(p.kind)) throw new KeycloakError(`Unknown kind "${String(p.kind)}".`);
  return p.kind;
};
const docKindOf = (p: Params): DocumentKind => {
  if (!isDocumentKind(p.kind)) throw new KeycloakError(`Unknown document "${String(p.kind)}".`);
  return p.kind;
};
const scopeOf = (p: Params, kind?: ResourceKind): Scope => ({ realm: kind === "realm" ? (optS(p, "realm") ?? needS(p, "id")) : needS(p, "realm"), parent: optS(p, "parent") });
const subjectOf = (p: Params): Subject => (p.subject === "group" ? "group" : "user");
const roles = (v: unknown): RoleRef[] => (Array.isArray(v) ? (v as RoleRef[]) : []);

/** The editor sends JSON text; accept objects too (callers inside the plugin). */
function jsonBody(v: unknown): Json {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch (err) {
      throw new KeycloakError(`The JSON is invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new KeycloakError("Expected a JSON object.");
  return v as Json;
}

// ---- operations ------------------------------------------------------------------------------------------------

export const API: Record<string, Handler> = {
  // -- discovery
  realms: async (c) =>
    (await c.get<Json[]>("/admin/realms"))
      .map((r) => ({ realm: String(r.realm), displayName: typeof r.displayName === "string" ? r.displayName : "", enabled: r.enabled !== false }))
      .sort((a, b) => a.realm.localeCompare(b.realm, undefined, { sensitivity: "base" })),
  serverVersion: async (c) => ((await c.get<{ systemInfo?: { version?: string } }>("/admin/serverinfo")).systemInfo?.version ?? ""),

  // -- generic resources
  list: (c, p) => listResources(c, kindOf(p), scopeOf(p, kindOf(p)), { search: optS(p, "search"), first: optN(p, "first"), max: optN(p, "max") }),
  get: async (c, p) => {
    const kind = kindOf(p);
    return { doc: await getResource(c, kind, scopeOf(p, kind), needS(p, "id")), readOnly: isReadOnly(kind) };
  },
  save: (c, p) => {
    const kind = kindOf(p);
    return saveResource(c, kind, scopeOf(p, kind), jsonBody(p.body), optS(p, "id"));
  },
  remove: async (c, p) => {
    const kind = kindOf(p);
    await deleteResource(c, kind, scopeOf(p, kind), needS(p, "id"));
    return {};
  },
  document: (c, p) => getDocument(c, { kind: docKindOf(p), realm: needS(p, "realm"), id: optS(p, "id"), provider: optS(p, "provider") }),
  saveDocument: async (c, p) => {
    await saveDocument(c, { kind: docKindOf(p), realm: needS(p, "realm"), id: optS(p, "id") }, jsonBody(p.body));
    return {};
  },
  setEnabled: async (c, p) => {
    const kind = kindOf(p);
    if (!["user", "client", "identityProvider", "realm"].includes(kind)) throw new KeycloakError(`${kind} can't be enabled or disabled.`);
    const scope = scopeOf(p, kind);
    const id = needS(p, "id");
    const doc = (await getResource(c, kind, scope, id)) as Json;
    return saveResource(c, kind, scope, { ...doc, enabled: p.enabled === true }, id);
  },

  // -- users
  createUser: async (c, p) => {
    const body: Json = {
      username: needS(p, "username"),
      enabled: p.enabled !== false,
      ...(optS(p, "email") ? { email: optS(p, "email"), emailVerified: p.emailVerified === true } : {}),
      ...(optS(p, "firstName") ? { firstName: optS(p, "firstName") } : {}),
      ...(optS(p, "lastName") ? { lastName: optS(p, "lastName") } : {}),
      ...(optS(p, "password") ? { credentials: [{ type: "password", value: optS(p, "password"), temporary: p.temporary === true }] } : {}),
    };
    return saveResource(c, "user", { realm: needS(p, "realm") }, body);
  },
  resetPassword: async (c, p) => {
    await c.put(`/${enc(needS(p, "realm"))}/users/${enc(needS(p, "id"))}/reset-password`, { type: "password", value: needS(p, "password"), temporary: p.temporary === true });
    return {};
  },
  logoutUser: async (c, p) => {
    await c.post(`/${enc(needS(p, "realm"))}/users/${enc(needS(p, "id"))}/logout`);
    return {};
  },
  unlockUser: async (c, p) => {
    await c.del(`/${enc(needS(p, "realm"))}/attack-detection/brute-force/users/${enc(needS(p, "id"))}`);
    return {};
  },
  userSessions: (c, p) => userSessions(c, needS(p, "realm"), needS(p, "id")),

  // -- clients
  secret: async (c, p) => {
    const path = `/${enc(needS(p, "realm"))}/clients/${enc(needS(p, "id"))}/client-secret`;
    if (p.regenerate === true) return (await c.post(path)).data;
    return c.get(path);
  },

  // -- realm operations
  clearCache: async (c, p) => {
    const which = { realm: "clear-realm-cache", user: "clear-user-cache", keys: "clear-keys-cache" }[String(p.which)];
    if (!which) throw new KeycloakError("Unknown cache.");
    await c.post(`/${enc(needS(p, "realm"))}/${which}`);
    return {};
  },
  logoutAll: async (c, p) => {
    await c.post(`/${enc(needS(p, "realm"))}/logout-all`);
    return {};
  },

  // -- sessions & events
  sessionStats: async (c, p) => ({ items: await sessionStats(c, needS(p, "realm")), hasMore: false }),
  clientSessions: (c, p) => clientSessions(c, needS(p, "realm"), needS(p, "id"), { first: optN(p, "first"), max: optN(p, "max") }),
  deleteSession: async (c, p) => {
    await deleteSession(c, needS(p, "realm"), needS(p, "id"), p.offline === true);
    return {};
  },
  events: (c, p) =>
    listEvents(c, needS(p, "realm"), p.events === "admin" ? "adminEvents" : "events", {
      first: optN(p, "first"),
      max: optN(p, "max"),
      type: optS(p, "type"),
      user: optS(p, "user"),
      client: optS(p, "client"),
      resourceType: optS(p, "resourceType"),
      dateFrom: optS(p, "dateFrom"),
      dateTo: optS(p, "dateTo"),
    }),

  // -- groups, roles & mappings
  groupChildren: async (c, p) => childGroups(c, needS(p, "realm"), optS(p, "parent")),
  allGroups: (c, p) => allGroups(c, needS(p, "realm")),
  groupMembers: (c, p) => groupMembers(c, needS(p, "realm"), needS(p, "id"), optN(p, "first"), optN(p, "max")),
  roleUsers: (c, p) => roleUsers(c, needS(p, "realm"), needS(p, "id"), optS(p, "parent")),
  mappings: async (c, p) => {
    const [realm, clients] = await Promise.all([
      realmMappings(c, needS(p, "realm"), subjectOf(p), needS(p, "id")),
      clientMappingOverview(c, needS(p, "realm"), subjectOf(p), needS(p, "id")),
    ]);
    return { realm, clients };
  },
  clientMappings: (c, p) => clientMappings(c, needS(p, "realm"), subjectOf(p), needS(p, "id"), needS(p, "clientUuid")),
  updateMappings: async (c, p) => {
    const target = p.scope === "client" ? ({ scope: "client", clientUuid: needS(p, "clientUuid") } as const) : ({ scope: "realm" } as const);
    await updateMappings(c, needS(p, "realm"), subjectOf(p), needS(p, "id"), target, { add: roles(p.add), remove: roles(p.remove) });
    return {};
  },
  userGroups: (c, p) => userGroups(c, needS(p, "realm"), needS(p, "id")),
  setMembership: async (c, p) => {
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    await setMembership(c, needS(p, "realm"), needS(p, "id"), ids(p.join), ids(p.leave));
    return {};
  },

  // -- token tools
  getToken: (c, p) =>
    requestToken(c, {
      realm: needS(p, "realm"),
      clientId: needS(p, "clientId"),
      clientSecret: optS(p, "clientSecret"),
      grant: (["password", "client_credentials", "refresh_token"].includes(String(p.grant)) ? p.grant : "password") as Grant,
      username: optS(p, "username"),
      password: optS(p, "password"),
      refreshToken: optS(p, "refreshToken"),
      scope: optS(p, "scope"),
    }),
  introspect: (c, p) => introspectToken(c, { realm: needS(p, "realm"), clientId: needS(p, "clientId"), clientSecret: optS(p, "clientSecret"), token: needS(p, "token") }),
  userInfo: (c, p) => userInfo(c, { realm: needS(p, "realm"), token: needS(p, "token") }),
  exampleToken: (c, p) =>
    exampleToken(c, {
      realm: needS(p, "realm"),
      clientUuid: needS(p, "clientUuid"),
      userId: needS(p, "userId"),
      scope: optS(p, "scope"),
      kind: (["access", "id", "userinfo"].includes(String(p.what)) ? p.what : "access") as ExampleKind,
    }),
};

export type ApiResult = { ok: true; data: unknown } | { ok: false; error: string; status?: number };

/** Runs one operation, turning every failure into `{ ok: false, error }` — views show it instead of crashing. */
export async function callApi(client: KeycloakClient, method: string, params: Params): Promise<ApiResult> {
  const handler = API[method];
  if (!handler) return { ok: false, error: `Unknown operation "${method}".` };
  try {
    return { ok: true, data: await withOp(method, () => handler(client, params)) };
  } catch (err) {
    if (err instanceof KeycloakError) return { ok: false, error: err.message, ...(err.status !== undefined ? { status: err.status } : {}) };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
