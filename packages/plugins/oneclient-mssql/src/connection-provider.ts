import sql from "mssql";
import type { ConnectionProvider } from "@oneclient/plugin-api";
import { closeTunnel, sshEnabled, sshSchemaProperties, tunnelFor } from "@oneclient/sql-core";
import { AUTH_NTLM, AUTH_SQL, type MssqlConnectionConfig, toPoolConfig, tunnelTarget, viaTunnel } from "./config.js";
import { describeError } from "./errors.js";
import { closeSession, openSession } from "./sessions.js";

export function createConnectionProvider(): ConnectionProvider<MssqlConnectionConfig> {
  return {
    typeId: "mssql",
    configSchema: {
      type: "object",
      required: ["server"],
      properties: {
        server: {
          type: "string",
          title: "Server name",
          examples: ["localhost, 1433"],
          description: 'Host, "host,port" or "host\\instance" — same as SSMS.',
        },
        authentication: { type: "string", title: "Authentication", enum: [AUTH_SQL, AUTH_NTLM], default: AUTH_SQL },
        user: { type: "string", title: "Login" },
        password: { type: "string", title: "Password", "x-secret": true },
        domain: { type: "string", title: "Domain", description: "Windows Authentication only." },
        database: { type: "string", title: "Default database", examples: ["master"] },
        encrypt: { type: "boolean", title: "Encrypt connection", default: true },
        trustServerCertificate: {
          type: "boolean",
          title: "Trust server certificate",
          default: false,
          description: "Needed for local/dev servers with a self-signed certificate (e.g. SQL Server in Docker).",
        },
        ...sshSchemaProperties,
      },
    },

    async connect(config, ctx) {
      if (!ctx.connectionId) throw new Error("connect() requires a saved connection.");
      try {
        await openSession(ctx.connectionId, config);
      } catch (err) {
        throw new Error(describeError(err));
      }
      return { id: ctx.connectionId, typeId: "mssql", state: {} };
    },

    async test(config) {
      const started = Date.now();
      const testId = `test:${started}`;
      let pool: sql.ConnectionPool | undefined;
      try {
        const tunnel = sshEnabled(config) ? await tunnelFor(testId, config, tunnelTarget(config)) : undefined;
        pool = new sql.ConnectionPool(toPoolConfig(tunnel ? viaTunnel(config, tunnel) : config, { pool: { max: 1, min: 0 } }));
        await pool.connect();
        const result = await pool
          .request()
          .query<{ version: string; edition: string }>(
            "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version, CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition",
          );
        const row = result.recordset[0];
        return {
          success: true,
          message: `Connected — SQL Server ${row?.version ?? ""} (${row?.edition ?? "unknown edition"}).`,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        return { success: false, message: describeError(err) };
      } finally {
        await Promise.allSettled([pool?.close(), closeTunnel(testId)]);
      }
    },

    async disconnect(_handle, ctx) {
      if (ctx.connectionId) await closeSession(ctx.connectionId);
    },
  };
}
