import type Redis from "ioredis";

export type InfoSections = Record<string, Record<string, string>>;

/** INFO's "# Section\r\nkey:value" text → { section: { key: value } }. */
export function parseInfo(text: string): InfoSections {
  const out: InfoSections = {};
  let section = "default";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      section = line.slice(1).trim().toLowerCase();
      out[section] ??= {};
      continue;
    }
    const i = line.indexOf(":");
    if (i > 0) (out[section] ??= {})[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

export interface DatabaseInfo {
  index: number;
  keys: number;
  expires: number;
}

/** Databases with keys (from INFO keyspace), plus the configured default; `count` is CONFIG GET databases when allowed. */
export async function databases(client: Redis, defaultDb = 0): Promise<{ count: number; list: DatabaseInfo[] }> {
  const info = parseInfo(await client.info("keyspace"));
  const list: DatabaseInfo[] = Object.entries(info.keyspace ?? {}).map(([name, v]) => {
    const parts = Object.fromEntries(v.split(",").map((kv) => kv.split("=") as [string, string]));
    return { index: Number(name.replace(/^db/, "")), keys: Number(parts.keys ?? 0), expires: Number(parts.expires ?? 0) };
  });
  if (!list.some((d) => d.index === defaultDb)) list.push({ index: defaultDb, keys: 0, expires: 0 });
  list.sort((a, b) => a.index - b.index);
  let count = 16;
  try {
    const cfg = (await client.call("CONFIG", "GET", "databases")) as string[];
    count = Number(cfg[1]) || 16;
  } catch {
    /* CONFIG is often disabled on managed Redis */
  }
  return { count, list };
}

export interface ServerOverview {
  version: string;
  mode: string;
  os: string;
  uptimeDays: number;
  connectedClients: number;
  usedMemoryHuman: string;
  maxMemoryHuman: string;
  opsPerSec: number;
  hitRate: number | null;
  role: string;
  sections: InfoSections;
}

export async function serverOverview(client: Redis): Promise<ServerOverview> {
  const s = parseInfo(await client.info("everything").catch(() => client.info()));
  const hits = Number(s.stats?.keyspace_hits ?? 0);
  const misses = Number(s.stats?.keyspace_misses ?? 0);
  return {
    version: s.server?.redis_version ?? s.server?.valkey_version ?? "",
    mode: s.server?.redis_mode ?? s.server?.server_mode ?? "standalone",
    os: s.server?.os ?? "",
    uptimeDays: Number(s.server?.uptime_in_days ?? 0),
    connectedClients: Number(s.clients?.connected_clients ?? 0),
    usedMemoryHuman: s.memory?.used_memory_human ?? "",
    maxMemoryHuman: s.memory?.maxmemory_human ?? "0B",
    opsPerSec: Number(s.stats?.instantaneous_ops_per_sec ?? 0),
    hitRate: hits + misses > 0 ? hits / (hits + misses) : null,
    role: s.replication?.role ?? "",
    sections: s,
  };
}

export interface SlowEntry {
  id: number;
  time: number;
  micros: number;
  command: string;
  client: string;
}

export async function slowlog(client: Redis, count = 50): Promise<SlowEntry[]> {
  const raw = (await client.call("SLOWLOG", "GET", count)) as unknown[][];
  return raw.map((e) => ({
    id: Number(e[0]),
    time: Number(e[1]) * 1000,
    micros: Number(e[2]),
    command: (e[3] as string[]).map((a) => (/\s|"/.test(a) ? JSON.stringify(a) : a)).join(" "),
    client: String(e[4] ?? ""),
  }));
}
