import type { KeycloakClient } from "./client.js";

const enc = encodeURIComponent;
type Json = Record<string, unknown>;

export interface Paging {
  first?: number | undefined;
  max?: number | undefined;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

const bounds = (p: Paging) => ({ first: Math.max(0, p.first ?? 0), max: Math.min(500, Math.max(1, p.max ?? 50)) });
const asNumber = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

export interface SessionStat {
  /** Client uuid. */
  id: string;
  clientId: string;
  active: number;
  offline: number;
}

/** Active/offline session counts per client — the realm's sessions overview. Only clients with sessions are listed. */
export async function sessionStats(client: KeycloakClient, realm: string): Promise<SessionStat[]> {
  const rows = await client.get<Json[]>(`/${enc(realm)}/client-session-stats`);
  return rows
    .map((r) => ({ id: String(r.id), clientId: String(r.clientId), active: asNumber(r.active), offline: asNumber(r.offline) }))
    .sort((a, b) => b.active + b.offline - (a.active + a.offline) || a.clientId.localeCompare(b.clientId));
}

export interface SessionRow {
  id: string;
  username: string;
  userId: string;
  ipAddress: string;
  /** ISO-8601. */
  started: string;
  lastAccess: string;
  clients: string[];
  offline: boolean;
}

const toSession = (s: Json, offline: boolean): SessionRow => ({
  id: String(s.id ?? ""),
  username: String(s.username ?? ""),
  userId: String(s.userId ?? ""),
  ipAddress: String(s.ipAddress ?? ""),
  started: typeof s.start === "number" ? new Date(s.start).toISOString() : "",
  lastAccess: typeof s.lastAccess === "number" ? new Date(s.lastAccess).toISOString() : "",
  clients: Object.values((s.clients ?? {}) as Record<string, string>).map(String),
  offline,
});

/** Sessions of one client (online first, then offline tokens). */
export async function clientSessions(client: KeycloakClient, realm: string, clientUuid: string, paging: Paging = {}): Promise<Page<SessionRow>> {
  const { first, max } = bounds(paging);
  const base = `/${enc(realm)}/clients/${enc(clientUuid)}`;
  const [online, offline] = await Promise.all([
    client.get<Json[]>(`${base}/user-sessions`, { first, max: max + 1 }),
    client.get<Json[]>(`${base}/offline-sessions`, { first, max: max + 1 }).catch(() => [] as Json[]),
  ]);
  const rows = [...online.map((s) => toSession(s, false)), ...offline.map((s) => toSession(s, true))];
  return { items: rows.slice(0, max), hasMore: rows.length > max };
}

export async function userSessions(client: KeycloakClient, realm: string, userId: string): Promise<SessionRow[]> {
  const base = `/${enc(realm)}/users/${enc(userId)}`;
  const [online, offline] = await Promise.all([client.get<Json[]>(`${base}/sessions`), client.get<Json[]>(`${base}/offline-sessions`).catch(() => [] as Json[])]);
  return [...online.map((s) => toSession(s, false)), ...offline.map((s) => toSession(s, true))];
}

export async function deleteSession(client: KeycloakClient, realm: string, sessionId: string, offline: boolean): Promise<void> {
  await client.admin("DELETE", `/${enc(realm)}/sessions/${enc(sessionId)}`, { query: { isOffline: offline || undefined } });
}

// ---- Events -----------------------------------------------------------------------------------------------

export interface EventFilter extends Paging {
  /** Login events: one event type ("LOGIN_ERROR"). Admin events: one operation type ("CREATE"). */
  type?: string | undefined;
  user?: string | undefined;
  client?: string | undefined;
  /** Admin events: resource type ("USER", "CLIENT"…). */
  resourceType?: string | undefined;
  /** yyyy-MM-dd */
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
}

export interface EventRow {
  /** ISO-8601. */
  time: string;
  type: string;
  /** Login events: who/what; admin events: the resource path. */
  subject: string;
  client: string;
  ipAddress: string;
  error: string;
  details: Json;
}

export async function listEvents(client: KeycloakClient, realm: string, kind: "events" | "adminEvents", f: EventFilter): Promise<Page<EventRow>> {
  const { first, max } = bounds(f);
  const query: Record<string, string | number | undefined> = { first, max: max + 1, dateFrom: f.dateFrom || undefined, dateTo: f.dateTo || undefined };
  let rows: Json[];
  if (kind === "events") {
    rows = await client.get<Json[]>(`/${enc(realm)}/events`, { ...query, type: f.type || undefined, user: f.user || undefined, client: f.client || undefined });
  } else {
    rows = await client.get<Json[]>(`/${enc(realm)}/admin-events`, {
      ...query,
      operationTypes: f.type || undefined,
      resourceTypes: f.resourceType || undefined,
      authUser: f.user || undefined,
      authClient: f.client || undefined,
    });
  }
  const mapped = rows.map((e): EventRow => {
    const auth = (e.authDetails ?? {}) as Json;
    return {
      time: typeof e.time === "number" ? new Date(e.time).toISOString() : "",
      type: String(kind === "events" ? (e.type ?? "") : (e.operationType ?? "")),
      subject: String(kind === "events" ? (e.userId ?? "") : (e.resourcePath ?? e.resourceType ?? "")),
      client: String(kind === "events" ? (e.clientId ?? "") : (auth.clientId ?? "")),
      ipAddress: String(kind === "events" ? (e.ipAddress ?? "") : (auth.ipAddress ?? "")),
      error: String(e.error ?? ""),
      details: (kind === "events" ? (e.details ?? {}) : { resourceType: e.resourceType, authUser: auth.userId, representation: e.representation }) as Json,
    };
  });
  return { items: mapped.slice(0, max), hasMore: mapped.length > max };
}
