import { KafkaPluginError, describeKafkaError } from "./client.js";
import {
  addPartitions,
  alterTopicConfig,
  clusterOverview,
  createTopic,
  deleteGroup,
  deleteTopic,
  emptyTopic,
  groupDetail,
  listGroups,
  listTopics,
  resetOffsets,
  topicDetail,
} from "./cluster.js";
import { browse, produce } from "./messages.js";
import { producerFor, requireSession } from "./sessions.js";

type Params = Record<string, unknown>;
const str = (p: Params, key: string): string => {
  const v = p[key];
  if (typeof v !== "string" || !v) throw new KafkaPluginError(`Missing "${key}".`);
  return v;
};
const opt = (p: Params, key: string): string | undefined => (typeof p[key] === "string" ? (p[key] as string) : undefined);
const num = (p: Params, key: string): number | undefined => {
  const v = p[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new KafkaPluginError(`"${key}" must be a number.`);
  return n;
};
const record = (p: Params, key: string): Record<string, string> => {
  const v = p[key];
  if (!v || typeof v !== "object") return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k.trim()).map(([k, x]) => [k.trim(), String(x ?? "")]));
};

export type KafkaLogger = (level: "info" | "warn" | "error", message: string, detail?: string) => void;
let log: KafkaLogger = () => {};
export const setKafkaLogger = (fn: KafkaLogger): void => void (log = fn);

/** Everything the views do (`kafka.api`). Changes are logged to the Output panel. */
const API: Record<string, (cid: string, p: Params) => Promise<unknown>> = {
  cluster: async (cid) => clusterOverview(requireSession(cid).admin),
  topics: async (cid, p) => listTopics(requireSession(cid).admin, p.internal === true),
  topic: async (cid, p) => topicDetail(requireSession(cid).admin, str(p, "topic")),
  createTopic: async (cid, p) => {
    const name = str(p, "name").trim();
    await createTopic(requireSession(cid).admin, name, num(p, "partitions") ?? 1, num(p, "replicationFactor") ?? 1, record(p, "configs"));
    log("info", `created topic ${name}`);
    return {};
  },
  deleteTopic: async (cid, p) => {
    await deleteTopic(requireSession(cid).admin, str(p, "topic"));
    log("warn", `deleted topic ${str(p, "topic")}`);
    return {};
  },
  addPartitions: async (cid, p) => {
    await addPartitions(requireSession(cid).admin, str(p, "topic"), num(p, "count") ?? 0);
    log("info", `${str(p, "topic")}: partitions → ${num(p, "count")}`);
    return {};
  },
  emptyTopic: async (cid, p) => {
    const removed = await emptyTopic(requireSession(cid).admin, str(p, "topic"));
    log("warn", `emptied topic ${str(p, "topic")} (${removed} message(s))`);
    return { removed };
  },
  setConfig: async (cid, p) => {
    const value = p.value === null ? null : (opt(p, "value") ?? null);
    await alterTopicConfig(requireSession(cid).admin, str(p, "topic"), str(p, "name"), value);
    log("info", `${str(p, "topic")}: ${str(p, "name")} → ${value ?? "(default)"}`);
    return {};
  },
  browse: async (cid, p) => {
    const s = requireSession(cid);
    const from = (opt(p, "from") ?? "latest") as "latest" | "earliest" | "offset" | "timestamp";
    if (!["latest", "earliest", "offset", "timestamp"].includes(from)) throw new KafkaPluginError(`Unknown start "${from}".`);
    return browse(s.kafka, s.admin, str(p, "topic"), { from, partition: num(p, "partition"), offset: num(p, "offset"), timestamp: num(p, "timestamp"), limit: num(p, "limit") ?? 50 });
  },
  produce: async (cid, p) => {
    const topic = str(p, "topic");
    const partition = num(p, "partition");
    const count = num(p, "count");
    const key = opt(p, "key");
    const res = await produce(await producerFor(cid), topic, {
      value: typeof p.value === "string" ? p.value : "",
      headers: record(p, "headers"),
      ...(key ? { key } : {}),
      ...(partition !== undefined ? { partition } : {}),
      ...(count !== undefined ? { count } : {}),
    });
    log("info", `produced ${count ?? 1} message(s) to ${topic}`, res.map((r) => `partition ${r.partition} @ ${r.offset}`).join("\n"));
    return { results: res };
  },
  groups: async (cid) => listGroups(requireSession(cid).admin),
  group: async (cid, p) => groupDetail(requireSession(cid).admin, str(p, "groupId")),
  resetOffsets: async (cid, p) => {
    const to = str(p, "to") as "earliest" | "latest" | "timestamp";
    if (!["earliest", "latest", "timestamp"].includes(to)) throw new KafkaPluginError(`Unknown reset target "${to}".`);
    await resetOffsets(requireSession(cid).admin, str(p, "groupId"), str(p, "topic"), to, num(p, "timestamp"));
    log("warn", `group ${str(p, "groupId")}: reset offsets of ${str(p, "topic")} to ${to === "timestamp" ? new Date(num(p, "timestamp") ?? 0).toISOString() : to}`);
    return {};
  },
  deleteGroup: async (cid, p) => {
    await deleteGroup(requireSession(cid).admin, str(p, "groupId"));
    log("warn", `deleted consumer group ${str(p, "groupId")}`);
    return {};
  },
};

export type ApiResult = { ok: true; data: unknown } | { ok: false; error: string };

export async function callApi(connectionId: string | undefined, method: string, params: Params): Promise<ApiResult> {
  try {
    if (!connectionId) throw new KafkaPluginError("No connection id provided.");
    const handler = API[method];
    if (!handler) throw new KafkaPluginError(`Unknown operation "${method}".`);
    return { ok: true, data: await handler(connectionId, params) };
  } catch (err) {
    const error = err instanceof KafkaPluginError ? err.message : describeKafkaError(err);
    if (method !== "browse" && method !== "topic" && method !== "group") log("error", `${method} failed: ${error}`);
    return { ok: false, error };
  }
}
