import type Redis from "ioredis";
import { RedisPluginError } from "./client.js";

/** Splits a command line like redis-cli: spaces separate, "double" and 'single' quotes group, \n \t \" escapes in double quotes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    let cur = "";
    while (i < line.length && !/\s/.test(line[i]!)) {
      const c = line[i]!;
      if (c === '"' || c === "'") {
        const q = c;
        i++;
        let closed = false;
        while (i < line.length) {
          const d = line[i]!;
          if (d === "\\" && q === '"' && i + 1 < line.length) {
            const e = line[++i]!;
            cur += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
            i++;
          } else if (d === q) {
            i++;
            closed = true;
            break;
          } else {
            cur += d;
            i++;
          }
        }
        if (!closed) throw new RedisPluginError("Unbalanced quotes.");
      } else {
        cur += c;
        i++;
      }
    }
    out.push(cur);
  }
  return out;
}

/** Commands that block or switch the connection into another mode — they'd hang the shared client. */
const REFUSED = new Set(["MONITOR", "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "SYNC", "PSYNC", "QUIT", "RESET", "CLIENT"]);
const BLOCKING = new Set(["BLPOP", "BRPOP", "BLMOVE", "BRPOPLPUSH", "BZPOPMIN", "BZPOPMAX", "BLMPOP", "BZMPOP", "XREAD", "XREADGROUP", "WAIT"]);
const SELECT_HINT = "Use the database picker instead of SELECT (each database has its own connection here).";

/** Formats a reply like redis-cli: (integer) 1, "string", (nil), numbered nested arrays, (error) …. */
export function formatReply(reply: unknown, indent = ""): string {
  if (reply === null || reply === undefined) return "(nil)";
  if (typeof reply === "number" || typeof reply === "bigint") return `(integer) ${reply}`;
  if (Buffer.isBuffer(reply)) return JSON.stringify(reply.toString("utf8"));
  if (typeof reply === "string") return /\n/.test(reply) && reply.includes(":") && !reply.includes('"') && reply.length > 200 ? reply : JSON.stringify(reply);
  if (reply instanceof Error) return `(error) ${reply.message}`;
  if (Array.isArray(reply)) {
    if (reply.length === 0) return "(empty array)";
    const width = String(reply.length).length;
    return reply
      .map((item, i) => {
        const label = `${String(i + 1).padStart(width)}) `;
        const body = formatReply(item, indent + " ".repeat(label.length));
        return `${i === 0 ? "" : indent}${label}${body}`;
      })
      .join("\n");
  }
  if (typeof reply === "object") return formatReply(Object.entries(reply as Record<string, unknown>).flat(), indent);
  return String(reply);
}

export interface CliResult {
  command: string;
  output: string;
  error: boolean;
  ms: number;
}

/** Runs one command line on the given database's client. */
export async function runCommand(client: Redis, line: string): Promise<CliResult> {
  const started = Date.now();
  const args = tokenize(line.trim());
  if (args.length === 0) throw new RedisPluginError("Type a command.");
  const [cmd, ...rest] = args as [string, ...string[]];
  const upper = cmd.toUpperCase();
  if (upper === "SELECT") return { command: line, output: `(error) ${SELECT_HINT}`, error: true, ms: 0 };
  if (REFUSED.has(upper) && !(upper === "CLIENT" && /^(LIST|INFO|ID|GETNAME)$/i.test(rest[0] ?? ""))) {
    return { command: line, output: `(error) ${upper} isn't available in this console (it would take over the connection).`, error: true, ms: 0 };
  }
  if (BLOCKING.has(upper) && !(upper === "XREAD" && !rest.some((a) => a.toUpperCase() === "BLOCK"))) {
    return { command: line, output: `(error) ${upper} blocks the connection — use the non-blocking form (e.g. LPOP, or XREAD without BLOCK).`, error: true, ms: 0 };
  }
  try {
    const reply = await client.call(cmd, ...rest);
    return { command: line, output: formatReply(reply), error: false, ms: Date.now() - started };
  } catch (err) {
    return { command: line, output: `(error) ${err instanceof Error ? err.message.replace(/^ReplyError: /, "") : String(err)}`, error: true, ms: Date.now() - started };
  }
}

/** Does this command change data? (Used to decide what to log in the Output panel.) */
export const isWriteCommand = (line: string): boolean => /^\s*(set|del|unlink|hset|hdel|lpush|rpush|lset|lrem|sadd|srem|zadd|zrem|xadd|xdel|expire|pexpire|persist|rename|renamenx|flushdb|flushall|incr|decr|incrby|append|mset|setex|getdel|json\.set|json\.del|eval|evalsha|fcall)\b/i.test(line);
