import { type AuthDef, type BodyDef, type FormField, type KV, type RequestDef, emptyRequest } from "./model.js";

/** Splits a shell-ish command line into words: handles '…', "…", $'…', backslash escapes and line continuations. */
export function tokenize(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || (c === "$" && text[i + 1] === "'")) {
      const ansi = c === "$";
      if (ansi) i++;
      i++;
      has = true;
      while (i < text.length && text[i] !== "'") {
        if (ansi && text[i] === "\\" && i + 1 < text.length) {
          const n = text[++i]!;
          cur += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
        } else cur += text[i];
        i++;
      }
    } else if (c === '"') {
      i++;
      has = true;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length && /["\\$`]/.test(text[i + 1]!)) i++;
        cur += text[i];
        i++;
      }
    } else if (c === "\\" && i + 1 < text.length) {
      cur += text[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) tokens.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

export interface CurlImport {
  request: RequestDef;
  /** Things in the command that oneClient ignores (e.g. `--insecure`). */
  notes: string[];
}

const kvOf = (key: string, value: string): KV => ({ key, value, enabled: true });

function parseHeader(h: string): KV | undefined {
  const i = h.indexOf(":");
  if (i < 0) return undefined;
  return kvOf(h.slice(0, i).trim(), h.slice(i + 1).trim());
}

function parseFormEncoded(text: string): KV[] | undefined {
  const parts = text.split("&").filter(Boolean);
  if (parts.length === 0 || !parts.every((p) => /^[^=]+=?/.test(p))) return undefined;
  try {
    return parts.map((p) => {
      const i = p.indexOf("=");
      const dec = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
      return kvOf(dec(i < 0 ? p : p.slice(0, i)), i < 0 ? "" : dec(p.slice(i + 1)));
    });
  } catch {
    return undefined;
  }
}

/** Parses a `curl …` command (as copied from browser dev tools, docs, Postman…) into a request. */
export function parseCurl(command: string): CurlImport {
  const words = tokenize(command.trim());
  if (words[0]?.toLowerCase() !== "curl") throw new Error('That does not start with "curl".');
  const req = emptyRequest();
  const notes: string[] = [];
  const data: string[] = [];
  const form: FormField[] = [];
  let method: string | undefined;
  let getMode = false;
  let url = "";
  let auth: AuthDef | undefined;

  const takesValue = new Set(["-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json", "-F", "--form", "-u", "--user", "-b", "--cookie", "-A", "--user-agent", "-e", "--referer", "--url", "-o", "--output", "-m", "--max-time", "--connect-timeout", "-x", "--proxy", "--cacert", "--cert", "--key", "-w", "--write-out", "-T", "--upload-file"]);

  for (let i = 1; i < words.length; i++) {
    let w = words[i]!;
    let inline: string | undefined;
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    if (eq > 0) {
      inline = w.slice(eq + 1);
      w = w.slice(0, eq);
    }
    // -XPOST style
    if (/^-[A-Za-z]./.test(w) && !w.startsWith("--") && takesValue.has(w.slice(0, 2))) {
      inline = w.slice(2);
      w = w.slice(0, 2);
    }
    const value = (): string => inline ?? words[++i] ?? "";
    switch (w) {
      case "-X":
      case "--request":
        method = value().toUpperCase();
        break;
      case "-H":
      case "--header": {
        const h = parseHeader(value());
        if (h) req.headers.push(h);
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
        data.push(value());
        break;
      case "--data-urlencode": {
        const v = value();
        const i2 = v.indexOf("=");
        data.push(i2 < 0 ? encodeURIComponent(v) : `${v.slice(0, i2)}=${encodeURIComponent(v.slice(i2 + 1))}`);
        break;
      }
      case "--json":
        data.push(value());
        if (!req.headers.some((h) => h.key.toLowerCase() === "content-type")) req.headers.push(kvOf("Content-Type", "application/json"));
        if (!req.headers.some((h) => h.key.toLowerCase() === "accept")) req.headers.push(kvOf("Accept", "application/json"));
        break;
      case "-F":
      case "--form": {
        const v = value();
        const i2 = v.indexOf("=");
        const key = i2 < 0 ? v : v.slice(0, i2);
        const val = i2 < 0 ? "" : v.slice(i2 + 1);
        form.push(val.startsWith("@") ? { key, value: val.slice(1), enabled: true, type: "file" } : { key, value: val, enabled: true, type: "text" });
        break;
      }
      case "-u":
      case "--user": {
        const v = value();
        const i2 = v.indexOf(":");
        auth = { type: "basic", username: i2 < 0 ? v : v.slice(0, i2), password: i2 < 0 ? "" : v.slice(i2 + 1) };
        break;
      }
      case "-b":
      case "--cookie":
        req.headers.push(kvOf("Cookie", value()));
        break;
      case "-A":
      case "--user-agent":
        req.headers.push(kvOf("User-Agent", value()));
        break;
      case "-e":
      case "--referer":
        req.headers.push(kvOf("Referer", value()));
        break;
      case "--url":
        url = value();
        break;
      case "-G":
      case "--get":
        getMode = true;
        break;
      case "-I":
      case "--head":
        method = "HEAD";
        break;
      case "-k":
      case "--insecure":
        notes.push("--insecure: enable \"Accept self-signed certificates\" in the connection if needed.");
        break;
      default:
        if (takesValue.has(w)) {
          value();
          notes.push(`${w} was ignored.`);
        } else if (!w.startsWith("-") && !url) {
          url = w;
        } else if (w.startsWith("-") && !["-L", "--location", "-s", "--silent", "-S", "--show-error", "-v", "--verbose", "--compressed", "-i", "--include", "-f", "--fail", "-g", "--globoff", "-#", "--progress-bar", "-N", "--no-buffer", "--http1.1", "--http2"].includes(w)) {
          notes.push(`${w} was ignored.`);
        }
    }
  }
  if (!url) throw new Error("No URL found in the curl command.");

  if (getMode && data.length) {
    url += `${url.includes("?") ? "&" : "?"}${data.join("&")}`;
    data.length = 0;
  }
  req.url = url;

  const ct = req.headers.find((h) => h.key.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  let body: BodyDef = { mode: "none" };
  if (form.length) body = { mode: "formdata", fields: form };
  else if (data.length) {
    const joined = data.join("&");
    if (ct.includes("x-www-form-urlencoded") || (!ct && /^[^{[\s][^\n]*=/.test(joined) && parseFormEncoded(joined))) {
      body = { mode: "urlencoded", fields: parseFormEncoded(joined) ?? [] };
      if (ct) req.headers = req.headers.filter((h) => h.key.toLowerCase() !== "content-type");
    } else {
      const language = ct.includes("json") || (!ct && /^\s*[{[]/.test(joined)) ? "json" : ct.includes("xml") ? "xml" : ct.includes("html") ? "html" : "text";
      body = { mode: "raw", raw: joined, language };
      if (language === "json" || ct.includes("json")) req.headers = req.headers.filter((h) => h.key.toLowerCase() !== "content-type");
    }
  }
  req.body = body;
  req.method = method ?? (body.mode !== "none" ? "POST" : "GET");
  // Authorization header → auth settings, for readability.
  const authHeader = req.headers.find((h) => h.key.toLowerCase() === "authorization");
  if (!auth && authHeader) {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.value);
    if (m) {
      auth = { type: "bearer", token: m[1]! };
      req.headers = req.headers.filter((h) => h !== authHeader);
    }
  }
  req.auth = auth ?? { type: "none" };
  return { request: req, notes };
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A `curl` command for a request whose variables are already resolved. */
export function toCurl(req: { method: string; url: string; headers: Array<[string, string]>; body?: string | undefined; form?: Array<{ key: string; value: string; file: boolean }> | undefined }): string {
  const lines = [`curl ${req.method === "GET" ? "" : `-X ${req.method} `}${shq(req.url)}`.replace("  ", " ")];
  for (const [k, v] of req.headers) lines.push(`-H ${shq(`${k}: ${v}`)}`);
  if (req.form) for (const f of req.form) lines.push(`-F ${shq(`${f.key}=${f.file ? "@" : ""}${f.value}`)}`);
  else if (req.body) lines.push(`--data-raw ${shq(req.body)}`);
  return lines.join(" \\\n  ");
}
