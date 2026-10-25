import { closeTunnel, sshEnabled, tunnelFor } from "@oneclient/sql-core";
import sql from "mssql";
import { type MssqlConnectionConfig, toPoolConfig, tunnelTarget, viaTunnel } from "./config.js";

interface ServerSession {
  /** As the user saved it (shown in the UI). */
  config: MssqlConnectionConfig;
  /** What the driver connects with: the same, or the local end of the SSH tunnel. */
  clientConfig: MssqlConnectionConfig;
  /** Shared pool for Object Explorer and metadata queries. */
  pool: sql.ConnectionPool;
  /** One single-connection pool per query window, so each window is its own SQL session (temp tables, USE, SET options persist). */
  windows: Map<string, WindowSession>;
}

interface WindowSession {
  pool: sql.ConnectionPool;
  lastUsed: number;
}

/** Each plugin runs in its own extension-host process, so module state is per-plugin. */
const sessions = new Map<string, ServerSession>();

/** Close query-window sessions nobody has used for this long (tabs can close without telling us). */
const WINDOW_IDLE_MS = 30 * 60 * 1000;

export async function openSession(connectionId: string, config: MssqlConnectionConfig): Promise<void> {
  await closeSession(connectionId);
  const tunnel = sshEnabled(config) ? await tunnelFor(connectionId, config, tunnelTarget(config)) : undefined;
  const clientConfig = tunnel ? viaTunnel(config, tunnel) : config;
  const pool = new sql.ConnectionPool(toPoolConfig(clientConfig, { pool: { max: 10, min: 0, idleTimeoutMillis: 60_000 } }));
  try {
    await pool.connect();
  } catch (err) {
    await Promise.allSettled([pool.close(), closeTunnel(connectionId)]);
    throw err;
  }
  sessions.set(connectionId, { config, clientConfig, pool, windows: new Map() });
}

export async function closeSession(connectionId: string): Promise<void> {
  const session = sessions.get(connectionId);
  if (!session) return closeTunnel(connectionId);
  sessions.delete(connectionId);
  await Promise.allSettled([session.pool.close(), ...[...session.windows.values()].map((w) => w.pool.close())]);
  await closeTunnel(connectionId);
}

export async function closeAll(): Promise<void> {
  await Promise.allSettled([...sessions.keys()].map((id) => closeSession(id)));
}

export function requireSession(connectionId: string | undefined): ServerSession {
  if (!connectionId) throw new Error("No connection id provided.");
  const session = sessions.get(connectionId);
  if (!session) throw new Error("Not connected to SQL Server — expand the connection in the explorer to reconnect.");
  return session;
}

/** The dedicated session behind one query window, created on first use. */
export async function windowPool(connectionId: string, windowId: string): Promise<sql.ConnectionPool> {
  const session = requireSession(connectionId);
  sweepIdleWindows(session);

  let window = session.windows.get(windowId);
  if (!window || (!window.pool.connected && !window.pool.connecting)) {
    const pool = new sql.ConnectionPool(
      toPoolConfig(session.clientConfig, { pool: { max: 1, min: 0, idleTimeoutMillis: WINDOW_IDLE_MS } }),
    );
    window = { pool, lastUsed: Date.now() };
    session.windows.set(windowId, window);
    await pool.connect();
  }
  window.lastUsed = Date.now();
  return window.pool;
}

function sweepIdleWindows(session: ServerSession): void {
  const now = Date.now();
  for (const [id, w] of session.windows) {
    if (now - w.lastUsed > WINDOW_IDLE_MS) {
      session.windows.delete(id);
      void w.pool.close().catch(() => undefined);
    }
  }
}
