import Redis, { type RedisOptions } from "ioredis";

export interface RedisConnectionConfig {
  host?: string;
  port?: number;
  /** Redis 6+ ACL user; empty = the default user. */
  username?: string;
  password?: string;
  tls?: boolean;
  allowSelfSignedCertificate?: boolean;
  /** Database shown first (0 by default). */
  database?: number;
}

export class RedisPluginError extends Error {}

/** A friendlier message for the usual connection problems. */
export function describeRedisError(err: unknown, cfg?: RedisConnectionConfig): string {
  const e = err as NodeJS.ErrnoException & { command?: { name?: string } };
  const where = cfg ? `${cfg.host ?? "localhost"}:${cfg.port ?? 6379}` : "the server";
  const msg = e?.message ?? String(err);
  if (e?.code === "ECONNREFUSED") return `Connection refused by ${where} — is Redis running and the port right?`;
  if (e?.code === "ENOTFOUND") return `Can't find the host ${cfg?.host ?? ""}.`;
  if (e?.code === "ETIMEDOUT" || /timed? ?out/i.test(msg)) return `${where} didn't answer in time.`;
  if (e?.code === "ECONNRESET") return `The connection to ${where} was reset — check TLS on/off and the port.`;
  if (/NOAUTH/.test(msg)) return "This server needs a password — add it to the connection.";
  if (/WRONGPASS|invalid username-password/i.test(msg)) return "Wrong user name or password.";
  if (/self[- ]signed|unable to verify/i.test(msg)) return `The TLS certificate of ${where} isn't trusted — enable "Accept self-signed certificate".`;
  return msg.replace(/^ReplyError: /, "");
}

export function clientOptions(cfg: RedisConnectionConfig, db: number): RedisOptions {
  const host = cfg.host?.trim() || "127.0.0.1";
  return {
    host,
    port: cfg.port || 6379,
    ...(cfg.username?.trim() ? { username: cfg.username.trim() } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
    db,
    // "localhost" first resolves to ::1 on Windows, which Docker port mappings often don't answer.
    ...(host === "localhost" ? { family: 4 } : {}),
    ...(cfg.tls ? { tls: { rejectUnauthorized: !cfg.allowSelfSignedCertificate, servername: host } } : {}),
    connectTimeout: 8000,
    commandTimeout: 30000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    lazyConnect: true,
    // Reconnect a few times after a drop, then give up (the explorer reconnects on next expand).
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 500, 2000)),
    connectionName: "oneClient",
  };
}

/** Opens a client on one database and checks it answers (PING). */
export async function openClient(cfg: RedisConnectionConfig, db = 0): Promise<Redis> {
  const client = new Redis(clientOptions(cfg, db));
  client.on("error", () => {
    /* surfaced through the failing command instead */
  });
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch (err) {
    client.disconnect();
    throw new RedisPluginError(describeRedisError(err, cfg));
  }
}
