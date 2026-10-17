import { AsyncLocalStorage } from "node:async_hooks";

/** One HTTP request the plugin made to a Keycloak server — what the "Keycloak Logs" panel lists. */
export interface LogEntry {
  /** Epoch ms when the request started. */
  time: number;
  /** The plugin operation that caused it ("list", "createUser", …) or "connect"/"explorer" when none. */
  op: string;
  server: string;
  method: string;
  /** Path + query, no host. */
  path: string;
  status?: number;
  ms: number;
  /** Network or HTTP error summary. */
  error?: string;
  request?: string | undefined;
  response?: string | undefined;
}

const MAX_BODY = 4000;
let sink: ((entry: LogEntry) => void) | null = null;

/** Where finished requests go — the plugin points this at its Output channel when it activates. */
export function setLogSink(fn: ((entry: LogEntry) => void) | null): void {
  sink = fn;
}

const opStore = new AsyncLocalStorage<string>();

/** Runs `fn` so every request it makes is labelled with `op`. */
export const withOp = <T>(op: string, fn: () => Promise<T>): Promise<T> => opStore.run(op, fn);
export const currentOp = (): string => opStore.getStore() ?? "";

const SECRET_KEY = /(pass(word)?|secret|token|assertion|credential|authorization|value)$/i;

/** Hides secrets (passwords, client secrets, tokens) in JSON or form-encoded bodies before they are kept or shown. */
export function redact(body: string | undefined): string | undefined {
  if (!body) return undefined;
  let out = body;
  try {
    const walk = (v: unknown, key = ""): unknown => {
      if (Array.isArray(v)) return v.map((x) => walk(x, key));
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
      return typeof v === "string" && v !== "" && SECRET_KEY.test(key) ? "••••••" : v;
    };
    out = JSON.stringify(walk(JSON.parse(body)), null, 1);
  } catch {
    out = body.replace(/((?:^|&)[^=&]*(?:pass(?:word)?|secret|token|assertion)[^=&]*=)[^&]*/gi, "$1••••••");
  }
  return out.length > MAX_BODY ? `${out.slice(0, MAX_BODY)}\n… (${out.length - MAX_BODY} more characters)` : out;
}

export function addLog(entry: LogEntry): void {
  sink?.(entry);
}
