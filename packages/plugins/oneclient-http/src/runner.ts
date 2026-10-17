import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { basename } from "node:path";
import zlib from "node:zlib";
import type { AuthDef, BodyDef, KV, RequestDef } from "./model.js";
import { type Scope, interpolate } from "./vars.js";

export interface PreparedRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: Buffer | undefined;
  /** Readable form of the body for cURL export / history (files shown by path). */
  bodyText?: string | undefined;
  form?: Array<{ key: string; value: string; file: boolean }> | undefined;
  unresolved: string[];
}

const has = (headers: Array<[string, string]>, name: string) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());

const enabled = <T extends KV>(list: T[]): T[] => list.filter((h) => h.enabled && h.key.trim() !== "");

const CONTENT_TYPES: Record<string, string> = { json: "application/json", xml: "application/xml", html: "text/html", javascript: "application/javascript", text: "text/plain" };

/**
 * Turns a request definition into what goes on the wire: `{{variables}}` replaced, auth applied (query-string API keys
 * included), body encoded. `auth` is the *effective* auth (already resolved through folder/collection inheritance).
 */
export function prepare(def: RequestDef, scope: Scope, auth: AuthDef): PreparedRequest {
  const unresolved = new Set<string>();
  const sub = (s: string) => interpolate(s, scope, unresolved).text;

  let url = sub(def.url.trim());
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  const headers: Array<[string, string]> = enabled(def.headers).map((h) => [sub(h.key), sub(h.value)]);

  switch (auth.type) {
    case "bearer":
      if (!has(headers, "authorization")) headers.push(["Authorization", `Bearer ${sub(auth.token)}`]);
      break;
    case "basic":
      if (!has(headers, "authorization")) headers.push(["Authorization", `Basic ${Buffer.from(`${sub(auth.username)}:${sub(auth.password)}`).toString("base64")}`]);
      break;
    case "apikey":
      if (auth.in === "header") {
        if (!has(headers, sub(auth.key))) headers.push([sub(auth.key), sub(auth.value)]);
      } else {
        url += `${url.includes("?") ? "&" : "?"}${encodeURIComponent(sub(auth.key))}=${encodeURIComponent(sub(auth.value))}`;
      }
      break;
    default:
      break;
  }

  let body: Buffer | undefined;
  let bodyText: string | undefined;
  let form: PreparedRequest["form"];
  const b: BodyDef = def.body;
  if (b.mode === "raw") {
    bodyText = sub(b.raw);
    body = Buffer.from(bodyText, "utf-8");
    if (!has(headers, "content-type")) headers.push(["Content-Type", CONTENT_TYPES[b.language] ?? "text/plain"]);
  } else if (b.mode === "urlencoded") {
    bodyText = enabled(b.fields)
      .map((f) => `${encodeURIComponent(sub(f.key))}=${encodeURIComponent(sub(f.value))}`)
      .join("&");
    body = Buffer.from(bodyText, "utf-8");
    if (!has(headers, "content-type")) headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
  } else if (b.mode === "formdata") {
    const fields = enabled(b.fields).map((f) => ({ key: sub(f.key), value: sub(f.value), file: f.type === "file" }));
    form = fields;
    const boundary = `----oneClient${randomBytes(12).toString("hex")}`;
    const chunks: Buffer[] = [];
    for (const f of fields) {
      if (f.file) {
        let data: Buffer;
        try {
          data = readFileSync(f.value);
        } catch (err) {
          throw new Error(`Can't read the file for field "${f.key}": ${err instanceof Error ? err.message : String(err)}`);
        }
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.key}"; filename="${basename(f.value)}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from("\r\n"));
      } else {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.key}"\r\n\r\n${f.value}\r\n`));
      }
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    body = Buffer.concat(chunks);
    if (!has(headers, "content-type")) headers.push(["Content-Type", `multipart/form-data; boundary=${boundary}`]);
  }

  return { method: def.method.toUpperCase() || "GET", url, headers, body, bodyText, form, unresolved: [...unresolved] };
}

// ---- sending --------------------------------------------------------------------------------------------------

export interface SendOptions {
  timeoutMs: number;
  followRedirects: boolean;
  allowSelfSigned: boolean;
  signal?: AbortSignal | undefined;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  cookies: string[];
  /** Total time including redirects. */
  ms: number;
  /** Bytes after decompression. */
  size: number;
  contentType: string;
  /** The body as text, or base64 when `binary`. Truncated to MAX_BODY_CHARS. */
  body: string;
  binary: boolean;
  truncated: boolean;
  /** Final URL after redirects. */
  url: string;
  redirects: string[];
}

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_BODY_CHARS = 5 * 1024 * 1024;
const MAX_REDIRECTS = 10;

interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function once(req: PreparedRequest, url: string, opts: SendOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`Not a valid URL: ${url}`));
      return;
    }
    const secure = target.protocol === "https:";
    if (!secure && target.protocol !== "http:") {
      reject(new Error(`Unsupported protocol "${target.protocol}" — use http:// or https://`));
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of req.headers) {
      const prev = headers[k];
      headers[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    const lower = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
    if (!lower.has("user-agent")) headers["User-Agent"] = "oneClient/0.1";
    if (!lower.has("accept")) headers["Accept"] = "*/*";
    if (!lower.has("accept-encoding")) headers["Accept-Encoding"] = "gzip, deflate, br";
    if (req.body && !lower.has("content-length") && !lower.has("transfer-encoding")) headers["Content-Length"] = String(req.body.length);

    const lib = secure ? https : http;
    const request = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
        ...(target.hostname === "localhost" ? { family: 4 } : {}),
        ...(secure && opts.allowSelfSigned ? { rejectUnauthorized: false } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            request.destroy(new Error(`The response is larger than ${MAX_BYTES / 1024 / 1024} MB.`));
            return;
          }
          chunks.push(c);
        });
        res.on("error", reject);
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
          const done = (body: Buffer) => resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers: res.headers, body });
          const decode = enc === "gzip" || enc === "x-gzip" ? zlib.gunzip : enc === "deflate" ? zlib.inflate : enc === "br" ? zlib.brotliDecompress : null;
          if (!decode || raw.length === 0) return done(raw);
          decode(raw, (err, out) => (err ? done(raw) : done(out)));
        });
      },
    );
    request.setTimeout(opts.timeoutMs, () => request.destroy(new Error(`The request timed out after ${Math.round(opts.timeoutMs / 1000)} s.`)));
    request.on("error", reject);
    if (req.body) request.write(req.body);
    request.end();
  });
}

function describeNetworkError(err: unknown, url: string): string {
  const e = err as NodeJS.ErrnoException;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (e.name === "AbortError" || e.code === "ABORT_ERR") return "Cancelled.";
  switch (e.code) {
    case "ECONNREFUSED":
      return `Connection refused by ${host} — is the server running and the port right?`;
    case "ENOTFOUND":
      return `Can't find the host "${host}".`;
    case "ECONNRESET":
      return `The connection to ${host} was reset — check http vs https and the port.`;
    case "ETIMEDOUT":
      return `${host} didn't answer in time.`;
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "CERT_HAS_EXPIRED":
      return `The certificate of ${host} isn't trusted (${e.code}) — enable "Accept self-signed certificates" in the connection.`;
    default:
      return e.message || String(err);
  }
}

function isText(contentType: string, body: Buffer): boolean {
  if (/^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|[\w.+-]*\+(json|xml)))/i.test(contentType) || /charset=/i.test(contentType)) return true;
  if (!contentType) {
    const head = body.subarray(0, 512);
    return !head.includes(0);
  }
  return false;
}

/** Sends the request, following redirects like a browser (303 and 301/302 on POST switch to GET). */
export async function send(prepared: PreparedRequest, opts: SendOptions): Promise<HttpResponse> {
  const started = Date.now();
  let current: PreparedRequest = prepared;
  let url = prepared.url;
  const redirects: string[] = [];
  let raw: RawResponse;
  for (let hop = 0; ; hop++) {
    try {
      raw = await once(current, url, opts);
    } catch (err) {
      throw new Error(describeNetworkError(err, url));
    }
    const location = raw.headers.location;
    if (opts.followRedirects && [301, 302, 303, 307, 308].includes(raw.status) && typeof location === "string" && hop < MAX_REDIRECTS) {
      const next = new URL(location, url).toString();
      redirects.push(`${raw.status} → ${next}`);
      const toGet = raw.status === 303 || ((raw.status === 301 || raw.status === 302) && current.method !== "GET" && current.method !== "HEAD");
      current = toGet
        ? { ...current, method: "GET", body: undefined, headers: current.headers.filter(([k]) => !/^content-(type|length)$/i.test(k)) }
        : current;
      // Don't leak credentials to another host.
      if (new URL(next).host !== new URL(url).host) current = { ...current, headers: current.headers.filter(([k]) => !/^(authorization|cookie)$/i.test(k)) };
      url = next;
      continue;
    }
    break;
  }

  const headers: Array<[string, string]> = [];
  const cookies: string[] = [];
  for (const [k, v] of Object.entries(raw.headers)) {
    if (v === undefined) continue;
    if (k.toLowerCase() === "set-cookie") cookies.push(...(Array.isArray(v) ? v : [v]));
    for (const one of Array.isArray(v) ? v : [v]) headers.push([k, one]);
  }
  const contentType = String(raw.headers["content-type"] ?? "");
  const binary = !isText(contentType, raw.body);
  let body = binary ? raw.body.toString("base64") : raw.body.toString("utf-8");
  const truncated = body.length > MAX_BODY_CHARS;
  if (truncated) body = body.slice(0, MAX_BODY_CHARS);
  return {
    status: raw.status,
    statusText: raw.statusText,
    headers,
    cookies,
    ms: Date.now() - started,
    size: raw.body.length,
    contentType,
    body,
    binary,
    truncated,
    url,
    redirects,
  };
}
