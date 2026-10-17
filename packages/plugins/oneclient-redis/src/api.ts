import { describeRedisError, RedisPluginError } from "./client.js";
import { isWriteCommand, runCommand } from "./cli.js";
import { createKey, deleteByPrefix, editKey, keyDetail, renameKey, scanKeys, setTtl } from "./keys.js";
import { databases, serverOverview, slowlog } from "./server.js";
import { clientFor, sessionConfig } from "./sessions.js";

type Params = Record<string, unknown>;

const str = (p: Params, key: string): string => {
  const v = p[key];
  if (typeof v !== "string") throw new RedisPluginError(`Missing "${key}".`);
  return v;
};
const db = (p: Params): number => {
  const v = Number(p.db ?? 0);
  if (!Number.isInteger(v) || v < 0) throw new RedisPluginError(`"${String(p.db)}" is not a database number.`);
  return v;
};

export type CommandLogger = (level: "info" | "warn" | "error", message: string, detail?: string) => void;
let log: CommandLogger = () => {};
export const setCommandLogger = (fn: CommandLogger): void => void (log = fn);

/** Everything the views do goes through here (`redis.api`). Writes are logged to the Output panel. */
const API: Record<string, (cid: string, p: Params) => Promise<unknown>> = {
  databases: async (cid) => databases(await clientFor(cid, sessionConfig(cid).database ?? 0), sessionConfig(cid).database ?? 0),
  scan: async (cid, p) =>
    scanKeys(await clientFor(cid, db(p)), {
      match: typeof p.match === "string" ? p.match : "*",
      ...(typeof p.type === "string" && p.type ? { type: p.type } : {}),
      ...(typeof p.cursor === "string" ? { cursor: p.cursor } : {}),
      limit: Number(p.limit) || 200,
      withTtl: true,
    }),
  key: async (cid, p) => keyDetail(await clientFor(cid, db(p)), str(p, "key")),
  edit: async (cid, p) => {
    const key = str(p, "key");
    const op = str(p, "op");
    await editKey(await clientFor(cid, db(p)), key, op, p);
    log("info", `db${db(p)} ${op} ${key}`);
    return {};
  },
  ttl: async (cid, p) => {
    const seconds = p.seconds === null || p.seconds === "" || p.seconds === undefined ? null : Number(p.seconds);
    await setTtl(await clientFor(cid, db(p)), str(p, "key"), seconds);
    log("info", `db${db(p)} ${seconds === null ? "PERSIST" : `EXPIRE ${seconds}`} ${str(p, "key")}`);
    return {};
  },
  rename: async (cid, p) => {
    await renameKey(await clientFor(cid, db(p)), str(p, "key"), str(p, "to"));
    log("info", `db${db(p)} RENAMENX ${str(p, "key")} → ${str(p, "to")}`);
    return {};
  },
  create: async (cid, p) => {
    await createKey(await clientFor(cid, db(p)), str(p, "key").trim(), str(p, "type"), typeof p.value === "string" ? p.value : "");
    log("info", `db${db(p)} create ${str(p, "type")} ${str(p, "key")}`);
    return {};
  },
  delete: async (cid, p) => {
    const keys = Array.isArray(p.keys) ? p.keys.filter((k): k is string => typeof k === "string") : [str(p, "key")];
    if (keys.length === 0) return { removed: 0 };
    const removed = Number(await (await clientFor(cid, db(p))).call("UNLINK", ...keys));
    log("warn", `db${db(p)} UNLINK ${keys.length === 1 ? keys[0] : `${keys.length} keys`}`, keys.join("\n"));
    return { removed };
  },
  deletePrefix: async (cid, p) => {
    const removed = await deleteByPrefix(await clientFor(cid, db(p)), str(p, "prefix"));
    log("warn", `db${db(p)} deleted ${removed} key(s) under "${str(p, "prefix")}"`);
    return { removed };
  },
  flushDb: async (cid, p) => {
    await (await clientFor(cid, db(p))).flushdb();
    log("warn", `db${db(p)} FLUSHDB`);
    return {};
  },
  info: async (cid, p) => serverOverview(await clientFor(cid, db(p))),
  slowlog: async (cid, p) => slowlog(await clientFor(cid, db(p))),
  cli: async (cid, p) => {
    const line = str(p, "line");
    const r = await runCommand(await clientFor(cid, db(p)), line);
    if (r.error || isWriteCommand(line)) log(r.error ? "error" : "info", `db${db(p)} > ${line}`, r.output.slice(0, 2000));
    return r;
  },
};

export type ApiResult = { ok: true; data: unknown } | { ok: false; error: string };

export async function callApi(connectionId: string | undefined, method: string, params: Params): Promise<ApiResult> {
  try {
    if (!connectionId) throw new RedisPluginError("No connection id provided.");
    const handler = API[method];
    if (!handler) throw new RedisPluginError(`Unknown operation "${method}".`);
    return { ok: true, data: await handler(connectionId, params) };
  } catch (err) {
    return { ok: false, error: err instanceof RedisPluginError ? err.message : describeRedisError(err) };
  }
}
