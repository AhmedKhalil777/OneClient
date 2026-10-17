import type { ConnectionProvider } from "@oneclient/plugin-api";
import { type RedisConnectionConfig, openClient } from "./client.js";
import { parseInfo } from "./server.js";
import { closeSession, openSession } from "./sessions.js";

export function createConnectionProvider(): ConnectionProvider<RedisConnectionConfig> {
  return {
    typeId: "redis",
    configSchema: {
      type: "object",
      required: ["host"],
      properties: {
        host: { type: "string", title: "Host", default: "127.0.0.1", examples: ["127.0.0.1"] },
        port: { type: "number", title: "Port", default: 6379 },
        username: { type: "string", title: "User name", description: "Redis 6+ ACL user. Leave empty for the default user." },
        password: { type: "string", title: "Password", "x-secret": true },
        database: { type: "number", title: "Default database", default: 0, minimum: 0 },
        tls: { type: "boolean", title: "Use TLS", default: false, description: "Managed services (Azure Cache, ElastiCache with TLS, Upstash…) usually need this." },
        allowSelfSignedCertificate: { type: "boolean", title: "Accept self-signed certificate", default: false },
      },
    },

    async connect(config, ctx) {
      if (!ctx.connectionId) throw new Error("connect() requires a saved connection.");
      await openSession(ctx.connectionId, config);
      return { id: ctx.connectionId, typeId: "redis", state: {} };
    },

    async test(config) {
      const started = Date.now();
      try {
        const client = await openClient(config, config.database ?? 0);
        try {
          const info = parseInfo(await client.info("server"));
          const version = info.server?.redis_version ?? info.server?.valkey_version ?? "";
          const keys = await client.dbsize();
          return { success: true, message: `Connected to Redis ${version} — ${keys} key${keys === 1 ? "" : "s"} in db${config.database ?? 0}.`, latencyMs: Date.now() - started };
        } finally {
          client.disconnect();
        }
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    async disconnect(_handle, ctx) {
      if (ctx.connectionId) await closeSession(ctx.connectionId);
    },
  };
}
