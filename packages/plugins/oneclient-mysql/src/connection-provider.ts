import type { ConnectionProvider } from "@oneclient/plugin-api";
import { closeTunnel, sshEnabled, sshSchemaProperties, tunnelFor } from "@oneclient/sql-core";
import mysql from "mysql2/promise";
import { type MysqlConnectionConfig, SSL_DISABLE, SSL_OPTIONS, toPoolOptions, tunnelTarget, viaTunnel } from "./config.js";
import { describeError } from "./errors.js";
import { closeSession, openSession } from "./sessions.js";

export function createConnectionProvider(): ConnectionProvider<MysqlConnectionConfig> {
  return {
    typeId: "mysql",
    configSchema: {
      type: "object",
      properties: {
        host: { type: "string", title: "Host", default: "localhost", examples: ["localhost"] },
        port: { type: "number", title: "Port", default: 3306 },
        user: { type: "string", title: "User", default: "root" },
        password: { type: "string", title: "Password", "x-secret": true },
        database: { type: "string", title: "Default database", description: "Optional: the database a new query window starts in. The explorer lists all of them." },
        ssl: { type: "string", title: "SSL", enum: SSL_OPTIONS, default: SSL_DISABLE, description: "Cloud servers (Azure, AWS RDS, PlanetScale…) usually need Require." },
        connectionString: {
          type: "string",
          title: "Connection string (optional)",
          "x-secret": true,
          description: "mysql://user:password@host:3306/db — replaces the fields above.",
        },
        showSystemObjects: { type: "boolean", title: "Show system databases (mysql, sys, …)", default: false },
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
      return { id: ctx.connectionId, typeId: "mysql", state: {} };
    },

    async test(config) {
      const started = Date.now();
      const testId = `test:${started}`;
      let conn: mysql.Connection | undefined;
      try {
        const tunnel = sshEnabled(config) ? await tunnelFor(testId, config, tunnelTarget(config)) : undefined;
        conn = await mysql.createConnection(toPoolOptions(tunnel ? viaTunnel(config, tunnel) : config));
        const [rows] = (await conn.query("SELECT VERSION() AS version, DATABASE() AS db")) as unknown as [Array<{ version: string; db: string | null }>];
        const row = rows[0];
        const version = row?.version ?? "";
        return { success: true, message: `Connected — ${/mariadb/i.test(version) ? version : `MySQL ${version}`}${row?.db ? `, database "${row.db}"` : ""}.`, latencyMs: Date.now() - started };
      } catch (err) {
        return { success: false, message: describeError(err) };
      } finally {
        await Promise.allSettled([conn?.end(), closeTunnel(testId)]);
      }
    },

    async disconnect(_handle, ctx) {
      if (ctx.connectionId) await closeSession(ctx.connectionId);
    },
  };
}
