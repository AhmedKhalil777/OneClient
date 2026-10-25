import type { SshConfig, Tunnel, TunnelTarget } from "@oneclient/sql-core";
import type { PoolOptions } from "mysql2/promise";

export interface MysqlConnectionConfig extends SshConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: string;
  /** mysql://user:pass@host:port/db — overrides the other fields when set. */
  connectionString?: string;
  showSystemObjects?: boolean;
  /** Set by viaTunnel(): the real host name, so certificate checks still use it when connecting to 127.0.0.1. */
  tlsServerName?: string;
}

export const SSL_DISABLE = "Disable";
export const SSL_REQUIRE = "Require (don't verify certificate)";
export const SSL_VERIFY = "Verify certificate";
export const SSL_OPTIONS = [SSL_DISABLE, SSL_REQUIRE, SSL_VERIFY];

export const SYSTEM_DATABASES = ["information_schema", "mysql", "performance_schema", "sys"];

/** The connection's parts, whether they came from the fields or from a connection string. */
export function parseConnection(config: MysqlConnectionConfig): { host: string; port: number; user: string; password: string; database: string | undefined; sslmode: string | null } {
  const conn = config.connectionString?.trim();
  if (conn) {
    const url = new URL(conn);
    if (!/^(mysql|mariadb):$/.test(url.protocol)) throw new Error('The connection string must start with "mysql://".');
    return {
      host: url.hostname,
      port: Number(url.port) || 3306,
      user: decodeURIComponent(url.username) || "root",
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)) || undefined,
      sslmode: url.searchParams.get("ssl-mode") ?? url.searchParams.get("sslmode"),
    };
  }
  const host = config.host?.trim();
  if (!host) throw new Error("Host is required.");
  return { host, port: Number(config.port) || 3306, user: config.user?.trim() || "root", password: config.password ?? "", database: config.database?.trim() || undefined, sslmode: null };
}

/**
 * Turns the saved form values into `mysql2` pool options. Values come back exactly as the server prints them: dates as
 * text (no time zone shifts), big numbers and decimals as text (no rounding), JSON as text.
 */
export function toPoolOptions(config: MysqlConnectionConfig, overrides: Partial<PoolOptions> = {}): PoolOptions {
  const c = parseConnection(config);
  const mode = c.sslmode?.toLowerCase();
  const verify = mode === "verify_identity" || mode === "verify-full" || mode === "verify_ca" || config.ssl === SSL_VERIFY;
  const required = verify || mode === "required" || mode === "require" || config.ssl === SSL_REQUIRE;
  return {
    // "localhost" can resolve to ::1 first; Docker port maps usually only answer on IPv4.
    host: c.host.toLowerCase() === "localhost" ? "127.0.0.1" : c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    ...(c.database ? { database: c.database } : {}),
    ...(required ? { ssl: verify ? { rejectUnauthorized: true, ...(config.tlsServerName ? { servername: config.tlsServerName } : {}) } : { rejectUnauthorized: false } } : {}),
    charset: "utf8mb4",
    connectTimeout: 15_000,
    enableKeepAlive: true,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    typeCast: typeCast as PoolOptions["typeCast"],
    ...overrides,
  } as PoolOptions;
}

interface CastField {
  type: string;
  string(): string | null;
  buffer(): Buffer | null;
}

/** JSON stays text (so what you see is what the server holds); BIT becomes a number. */
export function typeCast(field: CastField, next: () => unknown): unknown {
  if (field.type === "JSON") return field.string();
  if (field.type === "BIT") {
    const b = field.buffer();
    return b === null ? null : b.length <= 6 ? b.readUIntBE(0, b.length) : b.toString("hex");
  }
  return next();
}

/** The default database a connection opens, if it names one. */
export const defaultDatabase = (config: MysqlConnectionConfig): string | undefined => parseConnection(config).database;

/** What a query window shows as its connection: "host:port (user)". */
export function describeConnection(config: MysqlConnectionConfig): { server: string; login: string } {
  try {
    const c = parseConnection(config);
    return { server: `${c.host}:${c.port}`, login: c.user };
  } catch {
    return { server: "", login: "" };
  }
}

/** `name` — backticks, with ` doubled. */
export const quoteIdent = (name: string): string => `\`${name.replace(/`/g, "``")}\``;
export const qualified = (database: string, name: string): string => `${quoteIdent(database)}.${quoteIdent(name)}`;

/** Where the SSH server should connect to (as seen from the SSH server). */
export function tunnelTarget(config: MysqlConnectionConfig): TunnelTarget {
  const c = parseConnection(config);
  return { host: c.host, port: c.port };
}

/** The config the driver connects with when a tunnel is open: the local end of the tunnel, with the real name kept for TLS. */
export function viaTunnel(config: MysqlConnectionConfig, tunnel: Tunnel): MysqlConnectionConfig {
  const { host } = parseConnection(config);
  const conn = config.connectionString?.trim();
  if (conn) {
    const u = new URL(conn);
    u.hostname = tunnel.host;
    u.port = String(tunnel.port);
    return { ...config, connectionString: u.toString(), tlsServerName: host };
  }
  return { ...config, host: tunnel.host, port: tunnel.port, tlsServerName: host };
}
