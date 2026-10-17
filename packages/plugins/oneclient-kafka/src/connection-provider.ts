import type { ConnectionProvider } from "@oneclient/plugin-api";
import { type KafkaConnectionConfig, SASL_NONE, SASL_OPTIONS, describeKafkaError, makeKafka } from "./client.js";
import { closeSession, openSession } from "./sessions.js";

export function createConnectionProvider(): ConnectionProvider<KafkaConnectionConfig> {
  return {
    typeId: "kafka",
    configSchema: {
      type: "object",
      required: ["brokers"],
      properties: {
        brokers: { type: "string", title: "Bootstrap servers", default: "127.0.0.1:9092", description: "host:port, comma-separated for several brokers." },
        sasl: { type: "string", title: "SASL authentication", enum: [...SASL_OPTIONS], default: SASL_NONE },
        username: { type: "string", title: "User name", description: "For SASL (Confluent Cloud: the API key)." },
        password: { type: "string", title: "Password", "x-secret": true, description: "For SASL (Confluent Cloud: the API secret)." },
        ssl: { type: "boolean", title: "Use TLS (SSL)", default: false },
        allowSelfSignedCertificate: { type: "boolean", title: "Accept self-signed certificate", default: false },
      },
    },

    async connect(config, ctx) {
      if (!ctx.connectionId) throw new Error("connect() requires a saved connection.");
      try {
        await openSession(ctx.connectionId, config);
      } catch (err) {
        throw new Error(describeKafkaError(err));
      }
      return { id: ctx.connectionId, typeId: "kafka", state: {} };
    },

    async test(config) {
      const started = Date.now();
      let admin: ReturnType<ReturnType<typeof makeKafka>["admin"]> | undefined;
      try {
        admin = makeKafka(config).admin();
        await admin.connect();
        const c = await admin.describeCluster();
        const topics = (await admin.listTopics()).filter((t) => !t.startsWith("__"));
        return {
          success: true,
          message: `Connected — ${c.brokers.length} broker${c.brokers.length === 1 ? "" : "s"}, ${topics.length} topic${topics.length === 1 ? "" : "s"} (cluster ${c.clusterId}).`,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        return { success: false, message: describeKafkaError(err) };
      } finally {
        await admin?.disconnect().catch(() => {});
      }
    },

    async disconnect(_handle, ctx) {
      if (ctx.connectionId) await closeSession(ctx.connectionId);
    },
  };
}
