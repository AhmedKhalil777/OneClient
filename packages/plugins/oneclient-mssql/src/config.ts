import type sql from "mssql";

export interface MssqlConnectionConfig {
  server?: string;
  port?: number;
  authentication?: string;
  user?: string;
  password?: string;
  domain?: string;
  database?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  connectTimeoutSeconds?: number;
}

export const AUTH_SQL = "SQL Server Authentication";
export const AUTH_NTLM = "Windows Authentication (NTLM)";

/**
 * Turns the saved form values into an `mssql` config. Defaults are applied
 * here, not trusted from the form: Tier 1 forms only display a schema
 * `default`, they don't submit it.
 */
export function toPoolConfig(config: MssqlConnectionConfig, overrides: Partial<sql.config> = {}): sql.config {
  const server = config.server?.trim();
  if (!server) throw new Error("Server name is required.");

  // Accept SSMS-style "host,port" and "host\instance" in the server box.
  let host = server;
  let port = config.port;
  let instanceName: string | undefined;
  const comma = /^(.*),\s*(\d+)$/.exec(host);
  if (comma) {
    host = comma[1]!;
    port = Number(comma[2]);
  }
  const backslash = host.indexOf("\\");
  if (backslash !== -1) {
    instanceName = host.slice(backslash + 1);
    host = host.slice(0, backslash);
  }
  // "localhost" can resolve to ::1 first; Docker Desktop (and some proxies) accept the IPv6 connection
  // and then reset it, and tedious doesn't fall back to IPv4 after a reset. SSMS's driver does, so
  // match it by going straight to IPv4 — local SQL Server always listens there.
  if (host === "." || host === "(local)" || host.toLowerCase() === "localhost") host = "127.0.0.1";

  const base: sql.config = {
    server: host,
    // A named instance is resolved through SQL Browser; an explicit port would override it.
    port: instanceName ? undefined : (port ?? 1433),
    database: config.database?.trim() || undefined,
    connectionTimeout: (config.connectTimeoutSeconds ?? 15) * 1000,
    requestTimeout: 0, // queries run until done or cancelled, like SSMS
    options: {
      encrypt: config.encrypt ?? true,
      trustServerCertificate: config.trustServerCertificate ?? false,
      instanceName,
      appName: "oneClient",
      enableArithAbort: true,
    },
    ...overrides,
  };

  if (config.authentication === AUTH_NTLM) {
    return {
      ...base,
      authentication: {
        type: "ntlm",
        options: { domain: config.domain ?? "", userName: config.user ?? "", password: config.password ?? "" },
      },
    };
  }
  return { ...base, user: config.user ?? "", password: config.password ?? "" };
}

/** What a query window shows as its connection: "server (login)". */
export function describeConnection(config: MssqlConnectionConfig): { server: string; login: string } {
  const login = config.authentication === AUTH_NTLM ? `${config.domain ? `${config.domain}\\` : ""}${config.user ?? ""}` : (config.user ?? "");
  return { server: config.server?.trim() ?? "", login };
}

export function quoteIdent(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}
