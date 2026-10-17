import pg from "pg";
import { type PgConnectionConfig, defaultDatabase, toClientConfig } from "./config.js";

interface ServerSession {
  config: PgConnectionConfig;
  /** A PostgreSQL connection is bound to one database, so the explorer keeps a small pool per database. */
  pools: Map<string, pg.Pool>;
  /** One dedicated connection per query window, so each window is its own session (temp tables, SET, transactions persist). */
  windows: Map<string, WindowSession>;
}

export interface WindowSession {
  client: pg.Client;
  database: string;
  lastUsed: number;
  /** Where NOTICE / WARNING messages of the running script go. */
  onNotice: ((text: string) => void) | null;
  /** Transaction status from the last ReadyForQuery: I (idle), T (in a transaction), E (failed transaction). */
  txStatus: string;
  /** Set when the connection dropped; the next run reconnects. */
  broken: boolean;
}

/** Each plugin runs in its own extension-host process, so module state is per-plugin. */
const sessions = new Map<string, ServerSession>();

/** Close query-window sessions nobody has used for this long (tabs can close without telling us). */
const WINDOW_IDLE_MS = 30 * 60 * 1000;

export async function openSession(connectionId: string, config: PgConnectionConfig): Promise<void> {
  await closeSession(connectionId);
  const session: ServerSession = { config, pools: new Map(), windows: new Map() };
  sessions.set(connectionId, session);
  try {
    // Connect to the default database right away so a bad password surfaces when the connection is expanded.
    await poolFor(connectionId).query("SELECT 1");
  } catch (err) {
    await closeSession(connectionId);
    throw err;
  }
}

export async function closeSession(connectionId: string): Promise<void> {
  const session = sessions.get(connectionId);
  if (!session) return;
  sessions.delete(connectionId);
  await Promise.allSettled([...[...session.pools.values()].map((p) => p.end()), ...[...session.windows.values()].map((w) => w.client.end())]);
}

export async function closeAll(): Promise<void> {
  await Promise.allSettled([...sessions.keys()].map((id) => closeSession(id)));
}

export function requireSession(connectionId: string | undefined): ServerSession {
  if (!connectionId) throw new Error("No connection id provided.");
  const session = sessions.get(connectionId);
  if (!session) throw new Error("Not connected to PostgreSQL — expand the connection in the explorer to reconnect.");
  return session;
}

/** The explorer / metadata pool for one database (the connection's default database when omitted). */
export function poolFor(connectionId: string | undefined, database?: string): pg.Pool {
  const session = requireSession(connectionId);
  const db = database || defaultDatabase(session.config);
  let pool = session.pools.get(db);
  if (!pool) {
    pool = new pg.Pool({ ...toClientConfig(session.config, db), max: 4, idleTimeoutMillis: 60_000 });
    pool.on("error", () => undefined); // an idle client dying (server restart) must not crash the host
    session.pools.set(db, pool);
  }
  return pool;
}

/** The dedicated connection behind one query window. Switching database reconnects (PostgreSQL has no USE). */
export async function windowSession(connectionId: string, windowId: string, database?: string): Promise<WindowSession> {
  const session = requireSession(connectionId);
  sweepIdleWindows(session);
  const db = database || session.windows.get(windowId)?.database || defaultDatabase(session.config);

  let w = session.windows.get(windowId);
  if (w && (w.broken || w.database !== db)) {
    session.windows.delete(windowId);
    void w.client.end().catch(() => undefined);
    w = undefined;
  }
  if (!w) {
    const client = new pg.Client(toClientConfig(session.config, db));
    const created: WindowSession = { client, database: db, lastUsed: Date.now(), onNotice: null, broken: false, txStatus: "I" };
    client.on("notice", (n) => created.onNotice?.(`${n.severity ?? "NOTICE"}:  ${n.message}`));
    (client as unknown as { connection: { on(e: string, fn: (m: { status?: string }) => void): void } }).connection.on("readyForQuery", (m) => (created.txStatus = m.status ?? "I"));
    client.on("error", () => (created.broken = true));
    client.on("end", () => (created.broken = true));
    await client.connect();
    session.windows.set(windowId, created);
    w = created;
  }
  w.lastUsed = Date.now();
  return w;
}

function sweepIdleWindows(session: ServerSession): void {
  const now = Date.now();
  for (const [id, w] of session.windows) {
    if (now - w.lastUsed > WINDOW_IDLE_MS) {
      session.windows.delete(id);
      void w.client.end().catch(() => undefined);
    }
  }
}
