import { randomUUID } from "node:crypto";
import type { Admin, Kafka, Producer } from "kafkajs";
import { KafkaPluginError } from "./client.js";

export interface BrowseOptions {
  /** One partition, or all. */
  partition?: number | undefined;
  from: "latest" | "earliest" | "offset" | "timestamp";
  offset?: number | undefined;
  /** Epoch ms. */
  timestamp?: number | undefined;
  /** Total messages to read (spread over partitions for "latest"). */
  limit: number;
}

export interface DecodedValue {
  /** UTF-8 text, or base64 when it isn't text. */
  text: string;
  encoding: "text" | "json" | "base64" | "null";
  size: number;
}

export interface MessageRow {
  partition: number;
  offset: string;
  timestamp: number;
  key: DecodedValue;
  value: DecodedValue;
  headers: Record<string, string>;
}

export interface BrowseResult {
  messages: MessageRow[];
  /** Per partition: where reading started and where the partition ends. */
  ranges: Array<{ partition: number; start: number; end: number }>;
  ms: number;
  /** Stopped by the time budget before reaching the requested end. */
  timedOut: boolean;
}

const MAX_LIMIT = 2000;
const MAX_VALUE_CHARS = 200_000;

export function decode(buf: Buffer | null | undefined): DecodedValue {
  if (!buf) return { text: "", encoding: "null", size: 0 };
  const size = buf.length;
  const text = buf.toString("utf8");
  // Valid UTF-8 round-trips; binary (Avro, Protobuf…) doesn't.
  if (Buffer.from(text, "utf8").equals(buf) && !/[\u0000-\u0008\u000e-\u001f]/.test(text)) {
    const trimmed = text.length > MAX_VALUE_CHARS ? text.slice(0, MAX_VALUE_CHARS) : text;
    if (/^\s*[[{]/.test(text)) {
      try {
        JSON.parse(text);
        return { text: trimmed, encoding: "json", size };
      } catch {
        /* not JSON */
      }
    }
    return { text: trimmed, encoding: "text", size };
  }
  return { text: buf.subarray(0, MAX_VALUE_CHARS).toString("base64"), encoding: "base64", size };
}

/**
 * Reads messages without joining any real consumer group's offsets: a throwaway group (deleted afterwards) is
 * assigned the topic, every partition is sought to the computed start, and reading stops at the partition's end
 * as it was when browsing started (so a busy topic doesn't stream forever).
 */
export async function browse(kafka: Kafka, admin: Admin, topic: string, o: BrowseOptions): Promise<BrowseResult> {
  const started = Date.now();
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(o.limit || 50)));
  const offsets = await admin.fetchTopicOffsets(topic);
  if (offsets.length === 0) throw new KafkaPluginError(`Topic "${topic}" doesn't exist.`);
  const wanted = offsets.filter((p) => o.partition === undefined || p.partition === o.partition);
  if (wanted.length === 0) throw new KafkaPluginError(`Partition ${o.partition} doesn't exist.`);

  let byTime: Array<{ partition: number; offset: string }> = [];
  if (o.from === "timestamp") {
    if (!o.timestamp) throw new KafkaPluginError("Pick a date and time.");
    byTime = await admin.fetchTopicOffsetsByTimestamp(topic, o.timestamp);
  }
  // "Newest" reads up to `limit` from every partition (capped overall), then keeps the newest `limit` by time,
  // so a lopsided topic still yields the real newest messages.
  const perPartition = Math.max(Math.ceil(limit / wanted.length), Math.min(limit, Math.floor(5000 / wanted.length)));
  const readCap = o.from === "latest" ? perPartition * wanted.length : limit;
  const ranges = wanted.map((p) => {
    const low = Number(p.low);
    const high = Number(p.high);
    let start: number;
    if (o.from === "earliest") start = low;
    else if (o.from === "offset") start = Math.min(high, Math.max(low, Math.round(o.offset ?? 0)));
    else if (o.from === "timestamp") {
      const t = Number(byTime.find((x) => x.partition === p.partition)?.offset ?? high);
      start = t < 0 ? high : Math.max(low, t);
    } else start = Math.max(low, high - perPartition);
    return { partition: p.partition, start, end: Math.min(high, start + (o.from === "latest" ? perPartition : limit)) };
  });
  const active = ranges.filter((r) => r.end > r.start);
  if (active.length === 0) return { messages: [], ranges, ms: Date.now() - started, timedOut: false };

  const groupId = `oneclient-browse-${randomUUID()}`;
  const consumer = kafka.consumer({ groupId, sessionTimeout: 10000, rebalanceTimeout: 10000, heartbeatInterval: 1000, maxWaitTimeInMs: 300, allowAutoTopicCreation: false });
  const messages: MessageRow[] = [];
  const done = new Set<number>(ranges.filter((r) => r.end <= r.start).map((r) => r.partition));
  for (const p of offsets) if (!wanted.some((w) => w.partition === p.partition)) done.add(p.partition);
  let timedOut = false;
  try {
    await consumer.connect();
    await consumer.subscribe({ topics: [topic], fromBeginning: true });
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ partition, message }) => {
        const r = active.find((x) => x.partition === partition);
        const off = Number(message.offset);
        if (!r || done.has(partition) || off < r.start) return;
        if (off < r.end && messages.length < readCap) {
          messages.push({
            partition,
            offset: message.offset,
            timestamp: Number(message.timestamp),
            key: decode(message.key),
            value: decode(message.value),
            headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => String(x)).join(", ") : v === undefined ? "" : String(v)])),
          });
        }
        if (off >= r.end - 1 || messages.length >= readCap) done.add(partition);
        if (done.size >= offsets.length || messages.length >= readCap) finish();
      },
    });
    // seek must follow run(): position every partition we read at its start.
    for (const r of active) consumer.seek({ topic, partition: r.partition, offset: String(r.start) });
    const budget = new Promise<void>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, 15000),
    );
    await Promise.race([finished, budget]);
  } finally {
    await consumer.disconnect().catch(() => {});
    await admin.deleteGroups([groupId]).catch(() => {});
  }
  messages.sort((a, b) => (o.from === "latest" ? b.timestamp - a.timestamp : a.timestamp - b.timestamp) || a.partition - b.partition || Number(a.offset) - Number(b.offset));
  if (messages.length > limit) messages.length = limit;
  return { messages, ranges, ms: Date.now() - started, timedOut: timedOut && messages.length < limit };
}

export interface ProduceInput {
  key?: string;
  value: string;
  headers?: Record<string, string>;
  partition?: number;
  /** Send this many copies (load testing); default 1. */
  count?: number;
}

export async function produce(producer: Producer, topic: string, input: ProduceInput): Promise<Array<{ partition: number; offset: string }>> {
  const count = Math.max(1, Math.min(10_000, Math.round(input.count ?? 1)));
  const message = {
    ...(input.key ? { key: input.key } : {}),
    value: input.value,
    ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}),
    ...(input.partition !== undefined ? { partition: input.partition } : {}),
  };
  const res = await producer.send({ topic, acks: -1, messages: Array.from({ length: count }, () => message) });
  return res.map((r) => ({ partition: r.partition, offset: r.baseOffset ?? "" }));
}
