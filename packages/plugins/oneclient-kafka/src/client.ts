import { Kafka, type KafkaConfig, logLevel } from "kafkajs";

export interface KafkaConnectionConfig {
  /** Comma-separated host:port list. */
  brokers?: string;
  sasl?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  allowSelfSignedCertificate?: boolean;
}

export const SASL_NONE = "none";
export const SASL_OPTIONS = [SASL_NONE, "plain", "scram-sha-256", "scram-sha-512"] as const;

export class KafkaPluginError extends Error {}

export function brokerList(cfg: KafkaConnectionConfig): string[] {
  const list = (cfg.brokers ?? "")
    .split(/[,\s]+/)
    .map((b) => b.trim())
    .filter(Boolean)
    // "localhost" resolves to ::1 first on Windows; Docker port mappings usually only answer on IPv4.
    .map((b) => b.replace(/^localhost(?=:|$)/i, "127.0.0.1"));
  if (list.length === 0) throw new KafkaPluginError("Enter at least one bootstrap server (host:port).");
  for (const b of list) if (!/^[^:\s]+:\d+$/.test(b) && !/^\[.+\]:\d+$/.test(b)) throw new KafkaPluginError(`"${b}" isn't host:port.`);
  return list;
}

export function makeKafka(cfg: KafkaConnectionConfig): Kafka {
  const sasl = cfg.sasl && cfg.sasl !== SASL_NONE ? cfg.sasl : undefined;
  if (sasl && (!cfg.username || !cfg.password)) throw new KafkaPluginError("SASL needs a user name and password.");
  const config: KafkaConfig = {
    clientId: "oneclient",
    brokers: brokerList(cfg),
    connectionTimeout: 8000,
    requestTimeout: 30000,
    logLevel: logLevel.NOTHING,
    retry: { retries: 2, initialRetryTime: 300 },
    ...(cfg.ssl ? { ssl: cfg.allowSelfSignedCertificate ? { rejectUnauthorized: false } : true } : {}),
    ...(sasl ? { sasl: { mechanism: sasl as "plain", username: cfg.username!, password: cfg.password! } } : {}),
  };
  return new Kafka(config);
}

/** Friendlier messages for the usual Kafka problems. */
export function describeKafkaError(err: unknown): string {
  // createTopics & co. wrap the broker's per-item errors in an aggregate.
  const inner = (err as { errors?: unknown[]; topicErrors?: unknown[] })?.errors?.[0] ?? (err as { topicErrors?: unknown[] })?.topicErrors?.[0];
  if (inner && typeof inner === "object" && (inner as { type?: string }).type) return describeKafkaError(inner);
  const e = err as { name?: string; message?: string; type?: string; code?: string; originalError?: { code?: string } };
  const msg = e?.message ?? String(err);
  const code = e?.code ?? e?.originalError?.code;
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(msg)) return "Connection refused — is the broker running, and is the port right?";
  if (code === "ENOTFOUND" || /ENOTFOUND/.test(msg)) return "Can't find the broker host — check the bootstrap servers.";
  if (/Connection timeout|ETIMEDOUT/i.test(msg)) return "The broker didn't answer in time (check the address, TLS and firewall).";
  if (e?.type === "SASL_AUTHENTICATION_FAILED" || /SASL|Authentication failed/i.test(msg)) return "Authentication failed — check the SASL mechanism, user name and password.";
  if (/self[- ]signed|unable to verify/i.test(msg)) return 'The broker\'s TLS certificate isn\'t trusted — enable "Accept self-signed certificate".';
  if (e?.type === "TOPIC_ALREADY_EXISTS") return "A topic with that name already exists.";
  if (e?.type === "UNKNOWN_TOPIC_OR_PARTITION") return "That topic doesn't exist (any more).";
  if (e?.type === "INVALID_REPLICATION_FACTOR") return "The replication factor is larger than the number of brokers.";
  if (e?.type === "NON_EMPTY_GROUP") return "The consumer group still has active members — stop its consumers first.";
  if (e?.type === "GROUP_ID_NOT_FOUND") return "That consumer group doesn't exist (any more).";
  if (e?.type === "TOPIC_AUTHORIZATION_FAILED" || e?.type === "CLUSTER_AUTHORIZATION_FAILED") return "Not authorised for that (check the user's ACLs).";
  return e?.type ? `${e.type}: ${msg}` : msg;
}
