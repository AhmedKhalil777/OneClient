import type Redis from "ioredis";
import { RedisPluginError } from "./client.js";

export type KeyType = "string" | "hash" | "list" | "set" | "zset" | "stream" | "ReJSON-RL" | "none" | string;

/** Escapes glob characters so a literal prefix can be used in SCAN MATCH. */
export const escapeGlob = (s: string): string => s.replace(/[*?[\]\\]/g, (c) => `\\${c}`);

async function types(client: Redis, keys: string[]): Promise<KeyType[]> {
  if (keys.length === 0) return [];
  const pipe = client.pipeline();
  for (const k of keys) pipe.type(k);
  const res = (await pipe.exec()) ?? [];
  return res.map(([, t]) => String(t ?? "none"));
}

export interface ScanPage {
  keys: Array<{ name: string; type: KeyType; ttl?: number }>;
  /** "0" when the scan is complete. */
  cursor: string;
  /** Keys examined by the server for this page (SCAN count hints, not exact). */
  scanned: number;
}

/**
 * One page of keys: keeps scanning until `limit` matches are found, the scan ends, or a time budget runs out —
 * SCAN with a sparse MATCH can return empty pages for a long time.
 */
export async function scanKeys(client: Redis, opts: { match?: string; type?: string; cursor?: string; limit?: number; withTtl?: boolean }): Promise<ScanPage> {
  const limit = Math.min(1000, Math.max(1, opts.limit ?? 200));
  const match = opts.match?.trim() || "*";
  let cursor = opts.cursor ?? "0";
  const found: string[] = [];
  const started = Date.now();
  let scanned = 0;
  do {
    const args: Array<string | number> = [cursor, "MATCH", match, "COUNT", 1000];
    if (opts.type) args.push("TYPE", opts.type);
    const [next, keys] = (await client.call("SCAN", ...args)) as [string, string[]];
    cursor = next;
    scanned += 1000;
    for (const k of keys) if (!found.includes(k)) found.push(k);
  } while (cursor !== "0" && found.length < limit && Date.now() - started < 3000);
  const page = found.slice(0, limit);
  const t = await types(client, page);
  let ttls: number[] = [];
  if (opts.withTtl && page.length) {
    const pipe = client.pipeline();
    for (const k of page) pipe.pttl(k);
    ttls = ((await pipe.exec()) ?? []).map(([, v]) => Number(v));
  }
  return { keys: page.map((name, i) => ({ name, type: t[i] ?? "none", ...(opts.withTtl ? { ttl: ttls[i] ?? -1 } : {}) })), cursor, scanned };
}

export interface NamespaceLevel {
  /** Sub-namespaces at this level: "user:" → { name: "1001", prefix: "user:1001:", count: 3 }. */
  folders: Array<{ name: string; prefix: string; count: number }>;
  keys: Array<{ name: string; label: string; type: KeyType }>;
  /** The level was cut short (too many keys) — the browser shows everything. */
  truncated: boolean;
}

const MAX_SCAN_KEYS = 20_000;

/**
 * The keys under `prefix`, grouped by the next `delimiter`-separated segment — the RedisInsight-style tree
 * ("user:1001:profile" shows as user › 1001 › profile).
 */
export async function namespaceLevel(client: Redis, prefix: string, delimiter = ":", maxChildren = 500): Promise<NamespaceLevel> {
  let cursor = "0";
  const folders = new Map<string, number>();
  const leaves: string[] = [];
  let seen = 0;
  const started = Date.now();
  do {
    const [next, keys] = (await client.call("SCAN", cursor, "MATCH", `${escapeGlob(prefix)}*`, "COUNT", 1000)) as [string, string[]];
    cursor = next;
    for (const k of keys) {
      seen++;
      const rest = k.slice(prefix.length);
      const i = delimiter ? rest.indexOf(delimiter) : -1;
      if (i >= 0) {
        const name = rest.slice(0, i);
        folders.set(name, (folders.get(name) ?? 0) + 1);
      } else if (!leaves.includes(k)) leaves.push(k);
    }
  } while (cursor !== "0" && seen < MAX_SCAN_KEYS && Date.now() - started < 5000);
  const truncated = cursor !== "0";
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const folderList = [...folders.entries()].sort(([a], [b]) => byName(a, b)).map(([name, count]) => ({ name, prefix: `${prefix}${name}${delimiter}`, count }));
  leaves.sort(byName);
  const shownLeaves = leaves.slice(0, Math.max(0, maxChildren - folderList.length));
  const t = await types(client, shownLeaves);
  return {
    folders: folderList.slice(0, maxChildren),
    keys: shownLeaves.map((name, i) => ({ name, label: name.slice(prefix.length) || name, type: t[i] ?? "none" })),
    truncated: truncated || leaves.length > shownLeaves.length || folderList.length > maxChildren,
  };
}

// ---- one key -------------------------------------------------------------------------------------------------

const MAX_STRING = 1024 * 1024;
const MAX_ITEMS = 1000;

export interface KeyDetail {
  key: string;
  type: KeyType;
  /** Milliseconds; -1 = no expiry, -2 = gone. */
  ttl: number;
  /** Bytes (MEMORY USAGE), when the server allows it. */
  memory?: number;
  encoding?: string;
  /** Number of elements (or string length). */
  length: number;
  value: unknown;
  /** Only the first items are shown. */
  truncated: boolean;
}

export async function keyDetail(client: Redis, key: string): Promise<KeyDetail> {
  const type = await client.type(key);
  if (type === "none") throw new RedisPluginError(`Key "${key}" doesn't exist (any more).`);
  const [ttl, memory, encoding] = await Promise.all([
    client.pttl(key),
    client.call("MEMORY", "USAGE", key).then(Number).catch(() => undefined),
    client.call("OBJECT", "ENCODING", key).then(String).catch(() => undefined),
  ]);
  const base = { key, type, ttl, ...(memory !== undefined ? { memory } : {}), ...(encoding ? { encoding } : {}) };
  switch (type) {
    case "string": {
      const length = await client.strlen(key);
      const value = length > MAX_STRING ? await client.getrange(key, 0, MAX_STRING - 1) : await client.get(key);
      return { ...base, length, value: value ?? "", truncated: length > MAX_STRING };
    }
    case "hash": {
      const length = await client.hlen(key);
      const fields: Array<[string, string]> = [];
      let cursor = "0";
      do {
        const [next, flat] = await client.hscan(key, cursor, "COUNT", 500);
        cursor = next;
        for (let i = 0; i < flat.length; i += 2) fields.push([flat[i]!, flat[i + 1]!]);
      } while (cursor !== "0" && fields.length < MAX_ITEMS);
      return { ...base, length, value: fields.slice(0, MAX_ITEMS), truncated: length > MAX_ITEMS };
    }
    case "list": {
      const length = await client.llen(key);
      return { ...base, length, value: await client.lrange(key, 0, MAX_ITEMS - 1), truncated: length > MAX_ITEMS };
    }
    case "set": {
      const length = await client.scard(key);
      const members: string[] = [];
      let cursor = "0";
      do {
        const [next, page] = await client.sscan(key, cursor, "COUNT", 500);
        cursor = next;
        members.push(...page);
      } while (cursor !== "0" && members.length < MAX_ITEMS);
      return { ...base, length, value: [...new Set(members)].slice(0, MAX_ITEMS).sort(), truncated: length > MAX_ITEMS };
    }
    case "zset": {
      const length = await client.zcard(key);
      const flat = await client.zrange(key, 0, MAX_ITEMS - 1, "WITHSCORES");
      const items: Array<[string, number]> = [];
      for (let i = 0; i < flat.length; i += 2) items.push([flat[i]!, Number(flat[i + 1])]);
      return { ...base, length, value: items, truncated: length > MAX_ITEMS };
    }
    case "stream": {
      const length = await client.xlen(key);
      const entries = (await client.xrevrange(key, "+", "-", "COUNT", 200)) as Array<[string, string[]]>;
      return { ...base, length, value: entries.map(([id, kv]) => ({ id, fields: Object.fromEntries(pairs(kv)) })), truncated: length > 200 };
    }
    case "ReJSON-RL": {
      const json = (await client.call("JSON.GET", key)) as string | null;
      return { ...base, length: json?.length ?? 0, value: json ?? "null", truncated: false };
    }
    default:
      return { ...base, length: 0, value: null, truncated: false };
  }
}

function pairs(flat: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i]!, flat[i + 1] ?? ""]);
  return out;
}

/** Applies one edit to a key. Every operation is a single Redis command (or a MULTI for the two-step ones). */
export async function editKey(client: Redis, key: string, op: string, p: Record<string, unknown>): Promise<void> {
  const s = (k: string) => {
    const v = p[k];
    if (typeof v !== "string") throw new RedisPluginError(`Missing "${k}".`);
    return v;
  };
  const n = (k: string) => {
    const v = Number(p[k]);
    if (!Number.isFinite(v)) throw new RedisPluginError(`"${k}" must be a number.`);
    return v;
  };
  switch (op) {
    case "set": {
      // Keep the TTL when overwriting a string (SET would clear it).
      const ttl = await client.pttl(key);
      if (ttl > 0) await client.set(key, s("value"), "PX", ttl);
      else await client.set(key, s("value"));
      return;
    }
    case "hset":
      if (typeof p.oldField === "string" && p.oldField !== s("field")) {
        await client.multi().hdel(key, p.oldField).hset(key, s("field"), s("value")).exec();
      } else await client.hset(key, s("field"), s("value"));
      return;
    case "hdel":
      await client.hdel(key, s("field"));
      return;
    case "lset":
      await client.lset(key, n("index"), s("value"));
      return;
    case "lpush":
      await client.lpush(key, s("value"));
      return;
    case "rpush":
      await client.rpush(key, s("value"));
      return;
    case "lremIndex": {
      // Lists have no "remove at index": mark the slot with a unique value, then remove that value.
      const marker = `__oneclient_removed_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
      await client.multi().lset(key, n("index"), marker).lrem(key, 1, marker).exec();
      return;
    }
    case "sadd":
      await client.sadd(key, s("member"));
      return;
    case "srem":
      await client.srem(key, s("member"));
      return;
    case "sreplace":
      await client.multi().srem(key, s("oldMember")).sadd(key, s("member")).exec();
      return;
    case "zadd":
      if (typeof p.oldMember === "string" && p.oldMember !== s("member")) await client.multi().zrem(key, p.oldMember).zadd(key, n("score"), s("member")).exec();
      else await client.zadd(key, n("score"), s("member"));
      return;
    case "zrem":
      await client.zrem(key, s("member"));
      return;
    case "xadd": {
      const fields = p.fields as Record<string, string> | undefined;
      if (!fields || Object.keys(fields).length === 0) throw new RedisPluginError("A stream entry needs at least one field.");
      await client.xadd(key, "*", ...Object.entries(fields).flat());
      return;
    }
    case "xdel":
      await client.xdel(key, s("id"));
      return;
    case "jsonset":
      await client.call("JSON.SET", key, "$", s("value"));
      return;
    default:
      throw new RedisPluginError(`Unknown edit "${op}".`);
  }
}

/** Seconds; `null` removes the expiry. */
export async function setTtl(client: Redis, key: string, seconds: number | null): Promise<void> {
  if (seconds === null) await client.persist(key);
  else if (seconds <= 0) throw new RedisPluginError("The TTL must be at least 1 second (or remove it).");
  else await client.expire(key, Math.round(seconds));
}

export async function renameKey(client: Redis, key: string, to: string): Promise<void> {
  if (!to) throw new RedisPluginError("Enter the new key name.");
  if (to === key) return;
  const ok = await client.renamenx(key, to);
  if (ok === 0) throw new RedisPluginError(`A key named "${to}" already exists.`);
}

export async function createKey(client: Redis, key: string, type: string, value: string): Promise<void> {
  if (!key) throw new RedisPluginError("Enter a key name.");
  if (await client.exists(key)) throw new RedisPluginError(`A key named "${key}" already exists.`);
  const v = value ?? "";
  switch (type) {
    case "string":
      await client.set(key, v);
      return;
    case "hash":
      await client.hset(key, "field", v || "value");
      return;
    case "list":
      await client.rpush(key, v || "item");
      return;
    case "set":
      await client.sadd(key, v || "member");
      return;
    case "zset":
      await client.zadd(key, 0, v || "member");
      return;
    case "stream":
      await client.xadd(key, "*", "field", v || "value");
      return;
    case "json":
      await client.call("JSON.SET", key, "$", v || "{}");
      return;
    default:
      throw new RedisPluginError(`Unknown type "${type}".`);
  }
}

/** Deletes every key under a prefix (SCAN + UNLINK in batches). Returns how many were removed. */
export async function deleteByPrefix(client: Redis, prefix: string): Promise<number> {
  if (!prefix) throw new RedisPluginError("Refusing to delete with an empty prefix — use Flush Database instead.");
  let cursor = "0";
  let removed = 0;
  do {
    const [next, keys] = (await client.call("SCAN", cursor, "MATCH", `${escapeGlob(prefix)}*`, "COUNT", 1000)) as [string, string[]];
    cursor = next;
    if (keys.length) removed += Number(await client.call("UNLINK", ...keys));
  } while (cursor !== "0");
  return removed;
}
