import { type Admin, ConfigResourceTypes } from "kafkajs";
import { KafkaPluginError } from "./client.js";

export interface ClusterOverview {
  clusterId: string;
  controller: number | null;
  brokers: Array<{ nodeId: number; host: string; port: number; controller: boolean }>;
  topics: number;
  partitions: number;
  underReplicated: number;
}

export async function clusterOverview(admin: Admin): Promise<ClusterOverview> {
  const c = await admin.describeCluster();
  const topics = await listTopics(admin, true);
  return {
    clusterId: c.clusterId,
    controller: c.controller,
    brokers: c.brokers.map((b) => ({ ...b, controller: b.nodeId === c.controller })).sort((a, b) => a.nodeId - b.nodeId),
    topics: topics.length,
    partitions: topics.reduce((n, t) => n + t.partitions, 0),
    underReplicated: topics.reduce((n, t) => n + t.underReplicated, 0),
  };
}

export interface TopicRow {
  name: string;
  internal: boolean;
  partitions: number;
  replicationFactor: number;
  underReplicated: number;
}

export async function listTopics(admin: Admin, includeInternal = false): Promise<TopicRow[]> {
  const names = await admin.listTopics();
  if (names.length === 0) return [];
  const meta = await admin.fetchTopicMetadata({ topics: names });
  return meta.topics
    .map((t) => ({
      name: t.name,
      internal: t.name.startsWith("__"),
      partitions: t.partitions.length,
      replicationFactor: Math.max(0, ...t.partitions.map((p) => p.replicas.length)),
      underReplicated: t.partitions.filter((p) => p.isr.length < p.replicas.length).length,
    }))
    .filter((t) => includeInternal || !t.internal)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface PartitionInfo {
  partition: number;
  leader: number;
  replicas: number[];
  isr: number[];
  low: number;
  high: number;
  /** high − low: messages currently retained (compacted topics may hold fewer). */
  messages: number;
}

export interface TopicDetail {
  name: string;
  partitions: PartitionInfo[];
  messages: number;
  configs: Array<{ name: string; value: string | null; isDefault: boolean; readOnly: boolean; sensitive: boolean }>;
}

export async function topicDetail(admin: Admin, topic: string): Promise<TopicDetail> {
  const meta = await admin.fetchTopicMetadata({ topics: [topic] });
  const t = meta.topics[0];
  if (!t) throw new KafkaPluginError(`Topic "${topic}" doesn't exist.`);
  const offsets = await admin.fetchTopicOffsets(topic);
  const partitions = t.partitions
    .map((p) => {
      const o = offsets.find((x) => x.partition === p.partitionId);
      const low = Number(o?.low ?? 0);
      const high = Number(o?.high ?? 0);
      return { partition: p.partitionId, leader: p.leader, replicas: p.replicas, isr: p.isr, low, high, messages: Math.max(0, high - low) };
    })
    .sort((a, b) => a.partition - b.partition);
  let configs: TopicDetail["configs"] = [];
  try {
    const res = await admin.describeConfigs({ resources: [{ type: ConfigResourceTypes.TOPIC, name: topic }], includeSynonyms: false });
    configs = (res.resources[0]?.configEntries ?? [])
      .map((c) => ({ name: c.configName, value: c.configValue, isDefault: c.isDefault, readOnly: c.readOnly, sensitive: c.isSensitive }))
      .sort((a, b) => Number(a.isDefault) - Number(b.isDefault) || a.name.localeCompare(b.name));
  } catch {
    /* DescribeConfigs may be denied by ACLs; the rest is still useful */
  }
  return { name: topic, partitions, messages: partitions.reduce((n, p) => n + p.messages, 0), configs };
}

const TOPIC_NAME = /^[a-zA-Z0-9._-]{1,249}$/;

export async function createTopic(admin: Admin, name: string, partitions: number, replicationFactor: number, configs: Record<string, string> = {}): Promise<void> {
  if (!TOPIC_NAME.test(name) || name === "." || name === "..") throw new KafkaPluginError("Topic names use letters, digits, '.', '_' and '-' (max 249).");
  if (!Number.isInteger(partitions) || partitions < 1) throw new KafkaPluginError("Partitions must be 1 or more.");
  if (!Number.isInteger(replicationFactor) || replicationFactor < 1) throw new KafkaPluginError("Replication factor must be 1 or more.");
  const created = await admin.createTopics({
    waitForLeaders: true,
    topics: [{ topic: name, numPartitions: partitions, replicationFactor, configEntries: Object.entries(configs).map(([n, value]) => ({ name: n, value })) }],
  });
  if (!created) throw new KafkaPluginError(`Topic "${name}" already exists.`);
}

export async function deleteTopic(admin: Admin, name: string): Promise<void> {
  await admin.deleteTopics({ topics: [name], timeout: 15000 });
}

export async function addPartitions(admin: Admin, topic: string, total: number): Promise<void> {
  const current = (await topicDetail(admin, topic)).partitions.length;
  if (!Number.isInteger(total) || total <= current) throw new KafkaPluginError(`The topic has ${current} partitions — enter a larger number (partitions can't be removed).`);
  await admin.createPartitions({ topicPartitions: [{ topic, count: total }] });
}

/** Deletes every message currently in the topic (records up to each partition's high watermark). */
export async function emptyTopic(admin: Admin, topic: string): Promise<number> {
  const offsets = await admin.fetchTopicOffsets(topic);
  const removed = offsets.reduce((n, o) => n + Math.max(0, Number(o.high) - Number(o.low)), 0);
  await admin.deleteTopicRecords({ topic, partitions: offsets.map((o) => ({ partition: o.partition, offset: o.high })) });
  return removed;
}

export async function alterTopicConfig(admin: Admin, topic: string, name: string, value: string | null): Promise<void> {
  if (!/^[a-z0-9.]+$/.test(name)) throw new KafkaPluginError(`"${name}" isn't a topic config name.`);
  // incrementalAlterConfigs isn't in kafkajs: alterConfigs replaces the topic's non-default set, so send all of them.
  const current = (await topicDetail(admin, topic)).configs.filter((c) => !c.isDefault && !c.readOnly && c.name !== name && c.value !== null);
  const entries = [...current.map((c) => ({ name: c.name, value: c.value as string })), ...(value === null || value === "" ? [] : [{ name, value }])];
  await admin.alterConfigs({ validateOnly: false, resources: [{ type: ConfigResourceTypes.TOPIC, name: topic, configEntries: entries }] });
}

// ---- consumer groups -------------------------------------------------------------------------------------------

export interface GroupRow {
  groupId: string;
  state: string;
  protocolType: string;
  members: number;
}

export async function listGroups(admin: Admin): Promise<GroupRow[]> {
  const { groups } = await admin.listGroups();
  const ids = groups.map((g) => g.groupId).filter((g) => !g.startsWith("oneclient-browse-"));
  if (ids.length === 0) return [];
  const desc = await admin.describeGroups(ids);
  return desc.groups
    .map((g) => ({ groupId: g.groupId, state: g.state, protocolType: g.protocolType || groups.find((x) => x.groupId === g.groupId)?.protocolType || "", members: g.members.length }))
    .sort((a, b) => a.groupId.localeCompare(b.groupId));
}

export interface GroupDetail {
  groupId: string;
  state: string;
  protocol: string;
  members: Array<{ memberId: string; clientId: string; host: string; assignments: string }>;
  offsets: Array<{ topic: string; partition: number; committed: number | null; end: number; lag: number | null }>;
  totalLag: number;
}

export async function groupDetail(admin: Admin, groupId: string): Promise<GroupDetail> {
  const desc = (await admin.describeGroups([groupId])).groups[0];
  if (!desc || desc.state === "Dead") throw new KafkaPluginError(`Consumer group "${groupId}" doesn't exist (any more).`);
  const committed = await admin.fetchOffsets({ groupId });
  const offsets: GroupDetail["offsets"] = [];
  for (const t of committed) {
    let ends: Array<{ partition: number; high: string }> = [];
    try {
      ends = await admin.fetchTopicOffsets(t.topic);
    } catch {
      /* topic deleted since */
    }
    for (const p of t.partitions) {
      const end = Number(ends.find((e) => e.partition === p.partition)?.high ?? 0);
      const c = Number(p.offset);
      const has = p.offset !== "-1" && Number.isFinite(c);
      offsets.push({ topic: t.topic, partition: p.partition, committed: has ? c : null, end, lag: has ? Math.max(0, end - c) : null });
    }
    // Partitions the group never committed on (empty when it read them, or added later) still matter.
    for (const e of ends) if (!t.partitions.some((p) => p.partition === e.partition)) offsets.push({ topic: t.topic, partition: e.partition, committed: null, end: Number(e.high), lag: null });
  }
  offsets.sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition);
  return {
    groupId,
    state: desc.state,
    protocol: desc.protocol,
    members: desc.members.map((m) => ({ memberId: m.memberId, clientId: m.clientId, host: m.clientHost, assignments: describeAssignment(m.memberAssignment) })),
    offsets,
    totalLag: offsets.reduce((n, o) => n + (o.lag ?? 0), 0),
  };
}

/** Decodes the standard consumer-protocol assignment ("topic: 0, 1, 2"); best effort. */
function describeAssignment(buf: Buffer): string {
  try {
    if (!buf || buf.length < 6) return "";
    let i = 2; // version
    const topics = buf.readInt32BE(i);
    i += 4;
    const out: string[] = [];
    for (let t = 0; t < topics && i < buf.length; t++) {
      const len = buf.readInt16BE(i);
      i += 2;
      const name = buf.subarray(i, i + len).toString("utf8");
      i += len;
      const n = buf.readInt32BE(i);
      i += 4;
      const parts: number[] = [];
      for (let k = 0; k < n; k++, i += 4) parts.push(buf.readInt32BE(i));
      out.push(`${name}: ${parts.join(", ")}`);
    }
    return out.join("; ");
  } catch {
    return "";
  }
}

/** Moves a group's committed offsets for a topic. The group must have no active members. */
export async function resetOffsets(admin: Admin, groupId: string, topic: string, to: "earliest" | "latest" | "timestamp", timestamp?: number): Promise<void> {
  const desc = (await admin.describeGroups([groupId])).groups[0];
  if (desc && desc.members.length > 0) throw new KafkaPluginError("The group has active consumers — stop them before resetting its offsets.");
  // Real offsets rather than kafkajs' -2/-1 sentinels, so the committed position (and lag) is concrete.
  const ends = await admin.fetchTopicOffsets(topic);
  let partitions: Array<{ partition: number; offset: string }>;
  if (to === "timestamp") {
    if (!timestamp || !Number.isFinite(timestamp)) throw new KafkaPluginError("Pick a date and time.");
    const byTime = await admin.fetchTopicOffsetsByTimestamp(topic, timestamp);
    partitions = ends.map((e) => {
      const t = byTime.find((x) => x.partition === e.partition)?.offset;
      return { partition: e.partition, offset: t === undefined || Number(t) < 0 ? e.high : t };
    });
  } else partitions = ends.map((e) => ({ partition: e.partition, offset: to === "earliest" ? e.low : e.high }));
  await admin.setOffsets({ groupId, topic, partitions });
}

export async function deleteGroup(admin: Admin, groupId: string): Promise<void> {
  await admin.deleteGroups([groupId]);
}
