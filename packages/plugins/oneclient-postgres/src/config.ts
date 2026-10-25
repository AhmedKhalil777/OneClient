import type { SshConfig, Tunnel, TunnelTarget } from "@oneclient/sql-core";
import type { ClientConfig } from "pg";

export interface PgConnectionConfig extends SshConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: string;
  /** postgres://user:pass@host:port/db?sslmode=… — overrides the other fields when set. */
  connectionString?: string;
  showSystemObjects?: boolean;
  /** Set by viaTunnel(): the real host name, so certificate checks still use it when connecting to 127.0.0.1. */
  tlsServerName?: string;
}

export const SSL_DISABLE = "Disable";
export const SSL_REQUIRE = "Require (don't verify certificate)";
export const SSL_VERIFY = "Verify certificate";
export const SSL_OPTIONS = [SSL_DISABLE, SSL_REQUIRE, SSL_VERIFY];

/** Values come back as display text, except the plain numbers and booleans (grid alignment / sorting). */
const NUMERIC_OIDS = new Set([21, 23, 26, 700, 701]); // int2, int4, oid, float4, float8
const BOOL_OID = 16;
export const pgTypes = {
  getTypeParser: (oid: number) => {
    if (NUMERIC_OIDS.has(oid)) return (v: string) => Number(v);
    if (oid === BOOL_OID) return (v: string) => v === "t";
    // int8, numeric, dates, json, arrays, bytea (\x…), intervals… stay exactly as the server prints them.
    return (v: string) => v;
  },
};

/**
 * Turns the saved form values into a `pg` client config for one database. Defaults are applied here:
 * Tier 1 forms display a schema `default` but don't submit it.
 */
export function toClientConfig(config: PgConnectionConfig, database?: string): ClientConfig {
  const base: ClientConfig = {
    application_name: "oneClient",
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
    types: pgTypes as ClientConfig["types"],
  };
  const conn = config.connectionString?.trim();
  if (conn) {
    const url = new URL(conn);
    if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error('The connection string must start with "postgres://".');
    const mode = url.searchParams.get("sslmode");
    url.searchParams.delete("sslmode");
    if (database) url.pathname = `/${encodeURIComponent(database)}`;
    if (url.hostname.toLowerCase() === "localhost") url.hostname = "127.0.0.1";
    const verify = config.tlsServerName ? { servername: config.tlsServerName } : true;
    const ssl = !mode || mode === "disable" || mode === "prefer" || mode === "allow" ? false : mode === "verify-full" || mode === "verify-ca" ? verify : { rejectUnauthorized: false };
    return { ...base, connectionString: url.toString(), ssl };
  }
  const host = config.host?.trim();
  if (!host) throw new Error("Host is required.");
  return {
    ...base,
    // "localhost" can resolve to ::1 first; Docker port maps usually only answer on IPv4.
    host: host.toLowerCase() === "localhost" ? "127.0.0.1" : host,
    port: Number(config.port) || 5432,
    user: config.user?.trim() || "postgres",
    password: config.password ?? "",
    database: database ?? (config.database?.trim() || "postgres"),
    ssl: !config.ssl || config.ssl === SSL_DISABLE ? false : config.ssl === SSL_VERIFY ? (config.tlsServerName ? { servername: config.tlsServerName } : true) : { rejectUnauthorized: false },
  };
}

/** Where the SSH server should connect to (as seen from the SSH server). */
export function tunnelTarget(config: PgConnectionConfig): TunnelTarget {
  const conn = config.connectionString?.trim();
  if (conn) {
    const u = new URL(conn);
    return { host: u.hostname, port: Number(u.port) || 5432 };
  }
  const host = config.host?.trim();
  if (!host) throw new Error("Host is required.");
  return { host, port: Number(config.port) || 5432 };
}

/** The config the driver connects with when a tunnel is open: the local end of the tunnel, with the real name kept for TLS. */
export function viaTunnel(config: PgConnectionConfig, tunnel: Tunnel): PgConnectionConfig {
  const conn = config.connectionString?.trim();
  const { host } = tunnelTarget(config);
  if (conn) {
    const u = new URL(conn);
    u.hostname = tunnel.host;
    u.port = String(tunnel.port);
    return { ...config, connectionString: u.toString(), tlsServerName: host };
  }
  return { ...config, host: tunnel.host, port: tunnel.port, tlsServerName: host };
}

/** The database a connection opens by default. */
export function defaultDatabase(config: PgConnectionConfig): string {
  const conn = config.connectionString?.trim();
  if (conn) {
    try {
      return decodeURIComponent(new URL(conn).pathname.slice(1)) || "postgres";
    } catch {
      return "postgres";
    }
  }
  return config.database?.trim() || "postgres";
}

/** What a query window shows as its connection: "host:port (user)". */
export function describeConnection(config: PgConnectionConfig): { server: string; login: string } {
  const conn = config.connectionString?.trim();
  if (conn) {
    try {
      const u = new URL(conn);
      return { server: `${u.hostname}:${u.port || 5432}`, login: decodeURIComponent(u.username) };
    } catch {
      return { server: "", login: "" };
    }
  }
  return { server: `${config.host?.trim() ?? ""}:${Number(config.port) || 5432}`, login: config.user?.trim() || "postgres" };
}

/** "name" quoted only when needed (upper case, spaces, keywords…). */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export const qualified = (schema: string, name: string): string => `${quoteIdent(schema)}.${quoteIdent(name)}`;

/** Reserved words that can't be bare identifiers. */
const RESERVED = new Set(
  `all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog current_date
  current_role current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign from
  grant group having in initially intersect into lateral leading limit localtime localtimestamp not null offset on only or order placing
  primary references returning select session_user some symmetric system_user table then to trailing true union unique user using variadic
  when where window with authorization binary collation concurrently cross current_schema freeze full ilike inner is isnull join left like
  natural notnull outer overlaps right similar tablesample verbose`.split(/\s+/),
);
