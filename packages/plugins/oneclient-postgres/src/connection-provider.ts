import pg from "pg";
import type { ConnectionProvider } from "@oneclient/plugin-api";
import { type PgConnectionConfig, SSL_DISABLE, SSL_OPTIONS, toClientConfig } from "./config.js";
import { describeError } from "./errors.js";
import { closeSession, openSession } from "./sessions.js";

export function createConnectionProvider(): ConnectionProvider<PgConnectionConfig> {
  return {
    typeId: "postgres",
    configSchema: {
      type: "object",
      properties: {
        host: { type: "string", title: "Host", default: "localhost", examples: ["localhost"] },
        port: { type: "number", title: "Port", default: 5432 },
        user: { type: "string", title: "User", default: "postgres" },
        password: { type: "string", title: "Password", "x-secret": true },
        database: { type: "string", title: "Database", default: "postgres", description: "The database to connect to first; the explorer lists all of them." },
        ssl: { type: "string", title: "SSL", enum: SSL_OPTIONS, default: SSL_DISABLE, description: "Cloud servers (Azure, AWS RDS, Supabase, Neon…) usually need Require." },
        connectionString: {
          type: "string",
          title: "Connection string (optional)",
          "x-secret": true,
          description: "postgres://user:password@host:5432/db?sslmode=require — replaces the fields above.",
        },
        showSystemObjects: { type: "boolean", title: "Show system schemas and template databases", default: false },
      },
    },

    async connect(config, ctx) {
      if (!ctx.connectionId) throw new Error("connect() requires a saved connection.");
      try {
        await openSession(ctx.connectionId, config);
      } catch (err) {
        throw new Error(describeError(err));
      }
      return { id: ctx.connectionId, typeId: "postgres", state: {} };
    },

    async test(config) {
      const started = Date.now();
      let client: pg.Client | undefined;
      try {
        client = new pg.Client(toClientConfig(config));
        await client.connect();
        const r = await client.query<{ version: string; db: string }>("SELECT current_setting('server_version') AS version, current_database() AS db");
        const row = r.rows[0];
        return { success: true, message: `Connected — PostgreSQL ${row?.version ?? ""}, database "${row?.db ?? ""}".`, latencyMs: Date.now() - started };
      } catch (err) {
        return { success: false, message: describeError(err) };
      } finally {
        await client?.end().catch(() => undefined);
      }
    },

    async disconnect(_handle, ctx) {
      if (ctx.connectionId) await closeSession(ctx.connectionId);
    },
  };
}
