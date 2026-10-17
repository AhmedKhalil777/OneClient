import type Redis from "ioredis";
import { type RedisConnectionConfig, RedisPluginError, openClient } from "./client.js";

/** Per saved connection: its config and one client per database used (Redis binds a connection to one db). */
interface Session {
  config: RedisConnectionConfig;
  clients: Map<number, Promise<Redis>>;
}

const sessions = new Map<string, Session>();

export async function openSession(connectionId: string, config: RedisConnectionConfig): Promise<void> {
  await closeSession(connectionId);
  const db = config.database ?? 0;
  const first = await openClient(config, db);
  sessions.set(connectionId, { config, clients: new Map([[db, Promise.resolve(first)]]) });
}

export async function closeSession(connectionId: string): Promise<void> {
  const s = sessions.get(connectionId);
  if (!s) return;
  sessions.delete(connectionId);
  await Promise.allSettled([...s.clients.values()].map(async (p) => (await p).quit()));
}

export async function closeAll(): Promise<void> {
  await Promise.allSettled([...sessions.keys()].map(closeSession));
}

function session(connectionId: string | undefined): Session {
  if (!connectionId) throw new RedisPluginError("No connection id provided.");
  const s = sessions.get(connectionId);
  if (!s) throw new RedisPluginError("Not connected to Redis — expand the connection in the explorer to reconnect.");
  return s;
}

export const sessionConfig = (connectionId: string | undefined): RedisConnectionConfig => session(connectionId).config;

/** The client for database `db` of a connection (opened on first use). */
export function clientFor(connectionId: string | undefined, db: number): Promise<Redis> {
  const s = session(connectionId);
  if (!Number.isInteger(db) || db < 0) throw new RedisPluginError(`"${db}" is not a database number.`);
  let p = s.clients.get(db);
  if (!p) {
    p = openClient(s.config, db);
    s.clients.set(db, p);
    p.catch(() => s.clients.delete(db));
  }
  return p;
}
