import { closeTunnel, sshEnabled, tunnelFor } from "@oneclient/sql-core";
import mysql from "mysql2/promise";
import { type MysqlConnectionConfig, toPoolOptions, tunnelTarget, viaTunnel } from "./config.js";

interface ServerSession {
  /** As the user saved it (shown in the UI). */
  config: MysqlConnectionConfig;
  /** What the driver connects with: the same, or the local end of the SSH tunnel. */
  clientConfig: MysqlConnectionConfig;
  /** Shared pool for the explorer, metadata and the table editor's reads. */
  pool: mysql.Pool;
  /** Pool whose connections accept several statements per request: the table editor's apply and CSV import send a batch per round trip. */
  batchPool?: mysql.Pool;
  /** One dedicated connection per query window, so each window is its own session (USE, SET, temp tables, transactions persist). */
  windows: Map<string, WindowSession>;
}

export interface WindowSession {
  connection: mysql.Connection;
  /** The database the session is in (USE), or null when none is selected. */
  database: string | null;
  threadId: number;
  lastUsed: number;
  /** Set when the connection dropped; the next run reconnects. */
  broken: boolean;
}

/** Each plugin runs in its own extension-host process, so module state is per-plugin. */
const sessions = new Map<string, ServerSession>();

/** Close query-window sessions nobody has used for this long (tabs can close without telling us). */
const WINDOW_IDLE_MS = 30 * 60 * 1000;

/** The table editor and CSV import write literals with \ escaped: a server running NO_BACKSLASH_ESCAPES would read them wrong. */
const normalizeMode = (pool: mysql.Pool) => {
  (pool as unknown as { pool: { on(e: string, fn: (c: { query(sql: string): void }) => void): void } }).pool.on("connection", (c) => c.query("SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', '')"));
};

export async function openSession(connectionId: string, config: MysqlConnectionConfig): Promise<void> {
  await closeSession(connectionId);
  const tunnel = sshEnabled(config) ? await tunnelFor(connectionId, config, tunnelTarget(config)) : undefined;
  const clientConfig = tunnel ? viaTunnel(config, tunnel) : config;
  const pool = mysql.createPool(toPoolOptions(clientConfig, { connectionLimit: 8, waitForConnections: true, idleTimeout: 60_000, maxIdle: 2 }));
  pool.on("connection", () => undefined);
  normalizeMode(pool);
  sessions.set(connectionId, { config, clientConfig, pool, windows: new Map() });
  try {
    // Connect right away so a bad password surfaces when the connection is expanded.
    await pool.query("SELECT 1");
  } catch (err) {
    await closeSession(connectionId);
    throw err;
  }
}

export async function closeSession(connectionId: string): Promise<void> {
  const session = sessions.get(connectionId);
  if (!session) return closeTunnel(connectionId);
  sessions.delete(connectionId);
  await Promise.allSettled([session.pool.end(), session.batchPool?.end(), ...[...session.windows.values()].map((w) => w.connection.end())]);
  await closeTunnel(connectionId);
}

export async function closeAll(): Promise<void> {
  await Promise.allSettled([...sessions.keys()].map((id) => closeSession(id)));
}

export function requireSession(connectionId: string | undefined): ServerSession {
  if (!connectionId) throw new Error("No connection id provided.");
  const session = sessions.get(connectionId);
  if (!session) throw new Error("Not connected to MySQL — expand the connection in the explorer to reconnect.");
  return session;
}

export const poolFor = (connectionId: string | undefined): mysql.Pool => requireSession(connectionId).pool;

/** The multi-statement pool, created on first use. */
export function batchPoolFor(connectionId: string): mysql.Pool {
  const session = requireSession(connectionId);
  if (!session.batchPool) {
    session.batchPool = mysql.createPool(toPoolOptions(session.clientConfig, { connectionLimit: 3, multipleStatements: true, waitForConnections: true, idleTimeout: 60_000, maxIdle: 1 }));
    normalizeMode(session.batchPool);
  }
  return session.batchPool;
}

/** The dedicated connection behind one query window, created on first use. */
export async function windowSession(connectionId: string, windowId: string): Promise<WindowSession> {
  const session = requireSession(connectionId);
  sweepIdleWindows(session);
  let w = session.windows.get(windowId);
  if (w?.broken) {
    session.windows.delete(windowId);
    void w.connection.end().catch(() => undefined);
    w = undefined;
  }
  if (!w) {
    const connection = await mysql.createConnection(toPoolOptions(session.clientConfig));
    const created: WindowSession = { connection, database: null, threadId: connection.threadId, lastUsed: Date.now(), broken: false };
    connection.on("error", () => (created.broken = true));
    connection.on("end", () => (created.broken = true));
    const [rows] = (await connection.query("SELECT DATABASE() AS db")) as unknown as [Array<{ db: string | null }>];
    created.database = rows[0]?.db ?? null;
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
      void w.connection.end().catch(() => undefined);
    }
  }
}

/** A connection of its own (not from a pool), for work that changes session state — USE, transactions kept open — and must not leak it. */
export async function dedicatedConnection(connectionId: string, database?: string): Promise<mysql.Connection> {
  const session = requireSession(connectionId);
  return mysql.createConnection(toPoolOptions(session.clientConfig, database ? { database } : {}));
}
