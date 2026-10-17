import type { Admin, Kafka, Producer } from "kafkajs";
import { type KafkaConnectionConfig, KafkaPluginError, makeKafka } from "./client.js";

interface Session {
  config: KafkaConnectionConfig;
  kafka: Kafka;
  admin: Admin;
  producer?: Promise<Producer>;
}

const sessions = new Map<string, Session>();

export async function openSession(connectionId: string, config: KafkaConnectionConfig): Promise<void> {
  await closeSession(connectionId);
  const kafka = makeKafka(config);
  const admin = kafka.admin();
  await admin.connect();
  sessions.set(connectionId, { config, kafka, admin });
}

export async function closeSession(connectionId: string): Promise<void> {
  const s = sessions.get(connectionId);
  if (!s) return;
  sessions.delete(connectionId);
  await Promise.allSettled([s.admin.disconnect(), s.producer?.then((p) => p.disconnect())]);
}

export async function closeAll(): Promise<void> {
  await Promise.allSettled([...sessions.keys()].map(closeSession));
}

export function requireSession(connectionId: string | undefined): Session {
  if (!connectionId) throw new KafkaPluginError("No connection id provided.");
  const s = sessions.get(connectionId);
  if (!s) throw new KafkaPluginError("Not connected to Kafka — expand the connection in the explorer to reconnect.");
  return s;
}

/** The connection's producer, connected on first use. */
export function producerFor(connectionId: string | undefined): Promise<Producer> {
  const s = requireSession(connectionId);
  if (!s.producer) {
    const p = s.kafka.producer({ allowAutoTopicCreation: false });
    s.producer = p.connect().then(() => p);
    s.producer.catch(() => delete s.producer);
  }
  return s.producer;
}
