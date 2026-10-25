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
  return assemble({ req, url, method, getMode, data, form, auth, notes });
}

interface Parts {
  req: RequestDef;
  url: string;
  method: string | undefined;
  getMode: boolean;
  data: string[];
  form: FormField[];
  auth: AuthDef | undefined;
  notes: string[];
}

/** What every flavour ends in: URL + method + headers + body pieces → one request (body kind and auth detected). */
function assemble({ req, url, method, getMode, data, form, auth, notes }: Parts): CurlImport {
  if (!url) throw new Error("No URL found in the command.");

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

// ---- what browsers copy -------------------------------------------------------------------------------------------

export type CommandFlavor = "curl" | "powershell" | "fetch";

const POWERSHELL = /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;
const FETCH = /^\s*(?:await\s+)?(?:\(\s*)?fetch\s*\(/i;

/** Which kind of command the text is, if any: curl (bash / cmd / curl.exe), PowerShell Invoke-WebRequest, or JavaScript fetch. */
export function detectCommand(text: string): CommandFlavor | undefined {
  const t = text.trim().replace(/^(?:\$|>|PS [^>]*>)\s+/, "");
  if (/^curl(?:\.exe)?(?=\s|$)/i.test(t)) return "curl";
  if (FETCH.test(t)) return "fetch";
  if (POWERSHELL.test(t) && !/^\s*[{[]/.test(t)) return "powershell";
  return undefined;
}

/** Windows cmd escapes with ^ ("Copy as cURL (cmd)"): drop the carets so what is left is an ordinary double-quoted command. */
function unescapeCmd(text: string): string {
  if (!/\^(?:\r?\n|")/.test(text)) return text;
  return text.replace(/\^\r?\n/g, " ").replace(/\^(.)/gs, "$1");
}

/**
 * Parses a command copied from a browser's dev tools — "Copy as cURL (bash)", "(cmd)", "Copy as PowerShell" or
 * "Copy as fetch" — or written by hand, into a request.
 */
export function parseCommand(input: string): CurlImport & { flavor: CommandFlavor } {
  const text = input.trim().replace(/^(?:\$|>|PS [^>]*>)\s+/, "");
  const flavor = detectCommand(text);
  if (!flavor) throw new Error("That is not a curl, PowerShell (Invoke-WebRequest / Invoke-RestMethod) or fetch command.");
  if (flavor === "fetch") return { ...parseFetch(text), flavor };
  if (flavor === "powershell") return { ...parsePowerShell(text), flavor };
  return { ...parseCurl(unescapeCmd(text).replace(/^curl\.exe/i, "curl")), flavor };
}

// ---- PowerShell ----

type PsValue = { kind: "text"; text: string } | { kind: "hash"; pairs: Array<[string, string]> } | { kind: "expr"; text: string };

/** Reads PowerShell words: bare words, '…' (with ''), "…" (with `" and "" and `n), and @{ k = v; … } hashtables. */
function psTokens(text: string): Array<{ dash: boolean; value: PsValue }> {
  const out: Array<{ dash: boolean; value: PsValue }> = [];
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && (/\s/.test(text[i]!) || (text[i] === "`" && /\r?\n/.test(text.slice(i + 1, i + 3))))) i += text[i] === "`" ? (text[i + 1] === "\r" ? 3 : 2) : 1;
  };
  const readString = (): string => {
    const q = text[i]!;
    i++;
    let s = "";
    while (i < text.length) {
      const c = text[i]!;
      if (q === "'") {
        if (c === "'" && text[i + 1] === "'") (s += "'", (i += 2));
        else if (c === "'") break;
        else (s += c, i++);
      } else if (c === "`" && i + 1 < text.length) {
        const n = text[i + 1]!;
        s += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n === "0" ? "\0" : n;
        i += 2;
      } else if (c === '"' && text[i + 1] === '"') (s += '"', (i += 2));
      else if (c === '"') break;
      else (s += c, i++);
    }
    i++;
    return s;
  };
  while (true) {
    skipSpace();
    if (i >= text.length) break;
    const c = text[i]!;
    if (c === "@" && text[i + 1] === "{") {
      i += 2;
      const pairs: Array<[string, string]> = [];
      while (i < text.length) {
        while (i < text.length && /[\s;]/.test(text[i]!)) i++;
        if (text[i] === "}") {
          i++;
          break;
        }
        let key = "";
        if (text[i] === '"' || text[i] === "'") key = readString();
        else while (i < text.length && !/[=\s}]/.test(text[i]!)) key += text[i++];
        while (i < text.length && /\s/.test(text[i]!)) i++;
        if (text[i] === "=") i++;
        while (i < text.length && /[ \t]/.test(text[i]!)) i++;
        let val = "";
        if (text[i] === '"' || text[i] === "'") val = readString();
        else while (i < text.length && !/[;\r\n}]/.test(text[i]!)) val += text[i++];
        if (key) pairs.push([key, val.trim()]);
      }
      out.push({ dash: false, value: { kind: "hash", pairs } });
    } else if (c === '"' || c === "'") {
      out.push({ dash: false, value: { kind: "text", text: readString() } });
    } else if (c === "(" || c === "$") {
      // an expression we cannot evaluate: $body, ($x | ConvertTo-Json) …
      let depth = 0;
      let expr = "";
      while (i < text.length) {
        const d = text[i]!;
        if (d === "(") depth++;
        if (d === ")") depth--;
        if (depth <= 0 && /\s/.test(d)) break;
        expr += d;
        i++;
        if (depth === 0 && d === ")") break;
      }
      out.push({ dash: false, value: { kind: "expr", text: expr } });
    } else {
      let w = "";
      while (i < text.length && !/\s/.test(text[i]!)) w += text[i++];
      out.push({ dash: w.startsWith("-") && w.length > 1 && !/^-\d/.test(w), value: { kind: "text", text: w } });
    }
  }
  return out;
}

function parsePowerShell(input: string): CurlImport {
  const notes: string[] = [];
  const req = emptyRequest();
  let userAgent: string | undefined;
  const cookies: string[] = [];

  // Chrome's "Copy as PowerShell" first sets up a $session with the user agent and cookies.
  const lines = input.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const ua = /^\s*\$session\.UserAgent\s*=\s*(["'])(.*)\1\s*$/.exec(line);
    const ck = /^\s*\$session\.Cookies\.Add\(\(New-Object System\.Net\.Cookie\((.*)\)\)\)\s*$/.exec(line);
    if (ua) userAgent = ua[2];
    else if (ck) {
      const args = [...ck[1]!.matchAll(/"((?:[^"`]|`.)*)"|'([^']*)'/g)].map((m) => (m[1] ?? m[2] ?? "").replace(/`(.)/g, "$1"));
      if (args[0]) cookies.push(`${args[0]}=${args[1] ?? ""}`);
    } else if (!/^\s*\$session\s*=/.test(line)) kept.push(line);
  }
  const body = kept.join("\n");
  const cmd = POWERSHELL.exec(body);
  if (!cmd) throw new Error("No Invoke-WebRequest / Invoke-RestMethod found.");
  const words = psTokens(body.slice(cmd.index + cmd[0].length));

  let url = "";
  let method: string | undefined;
  let contentType: string | undefined;
  const data: string[] = [];
  const text = (v: PsValue) => (v.kind === "text" ? v.text : "");
  const valueTaking = new Set(["-uri", "-method", "-headers", "-contenttype", "-body", "-useragent", "-websession", "-sessionvariable", "-credential", "-outfile", "-infile", "-timeoutsec", "-maximumredirection", "-proxy", "-certificate", "-token", "-authentication", "-form", "-transferencoding"]);

  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    if (!w.dash) {
      if (!url && w.value.kind === "text") url = w.value.text;
      continue;
    }
    const name = text(w.value).toLowerCase().replace(/:$/, "");
    const next = valueTaking.has(name) ? words[++k]?.value : undefined;
    switch (name) {
      case "-uri":
        if (next?.kind === "text") url = next.text;
        else notes.push("-Uri used a PowerShell variable or expression; the URL could not be read.");
        break;
      case "-method":
        method = text(next ?? { kind: "text", text: "" }).toUpperCase() || undefined;
        break;
      case "-headers":
        if (next?.kind === "hash") for (const [key, val] of next.pairs) req.headers.push(kvOf(key, val));
        else notes.push("-Headers was not a literal @{ … } table and was ignored.");
        break;
      case "-contenttype":
        contentType = text(next ?? { kind: "text", text: "" });
        break;
      case "-body":
        if (next?.kind === "text") data.push(next.text);
        else notes.push("-Body used a PowerShell variable or expression ($body, ConvertTo-Json …), which cannot be evaluated here — paste the body into the request.");
        break;
      case "-useragent":
        userAgent = text(next ?? { kind: "text", text: "" });
        break;
      case "-websession":
      case "-sessionvariable":
      case "-usebasicparsing":
      case "-skipcertificatecheck":
      case "-allowunencryptedauthentication":
        break;
      default:
        notes.push(`${text(w.value)} was ignored.`);
    }
  }
  if (contentType && !req.headers.some((h) => h.key.toLowerCase() === "content-type")) req.headers.push(kvOf("Content-Type", contentType));
  if (userAgent && !req.headers.some((h) => h.key.toLowerCase() === "user-agent")) req.headers.push(kvOf("User-Agent", userAgent));
  if (cookies.length && !req.headers.some((h) => h.key.toLowerCase() === "cookie")) req.headers.push(kvOf("Cookie", cookies.join("; ")));
  return assemble({ req, url, method, getMode: false, data, form: [], auth: undefined, notes });
}

// ---- fetch ----

/** Finds the end of a balanced {...} starting at `from` (strings respected). */
function balanced(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) i += text[i] === "\\" ? 2 : 1;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function parseFetch(input: string): CurlImport {
  const notes: string[] = [];
  const req = emptyRequest();
  const open = input.indexOf("(");
  const urlMatch = /^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`)/.exec(input.slice(open + 1));
  if (!urlMatch) throw new Error("Could not find the URL in the fetch call.");
  const unq = (s: string) => {
    try {
      return JSON.parse(`"${s.replace(/\\'/g, "'")}"`) as string;
    } catch {
      return s;
    }
  };
  const url = unq(urlMatch[1] ?? urlMatch[2] ?? urlMatch[3] ?? "");
  let options: Record<string, unknown> = {};
  const braceAt = input.indexOf("{", open + 1 + urlMatch[0].length);
  if (braceAt >= 0) {
    const end = balanced(input, braceAt);
    if (end > braceAt) {
      const raw = input.slice(braceAt, end + 1);
      try {
        options = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        try {
          // single quotes / unquoted keys / trailing commas from hand-written code
          options = JSON.parse(raw.replace(/,\s*([}\]])/g, "$1").replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'((?:[^'\\]|\\.)*)'/g, (_m, g: string) => JSON.stringify(g.replace(/\\'/g, "'")))) as Record<string, unknown>;
        } catch {
          notes.push("The fetch options could not be parsed; only the URL was imported.");
        }
      }
    }
  }
  const headers = options.headers;
  if (headers && typeof headers === "object") {
    for (const [k, v] of Array.isArray(headers) ? (headers as Array<[string, string]>) : Object.entries(headers as Record<string, unknown>)) req.headers.push(kvOf(String(k), String(v)));
  }
  const data: string[] = [];
  if (typeof options.body === "string") data.push(options.body);
  else if (options.body != null) notes.push("The fetch body was not a plain string (FormData, Blob…) and was ignored.");
  return assemble({ req, url, method: typeof options.method === "string" ? options.method.toUpperCase() : undefined, getMode: false, data, form: [], auth: undefined, notes });
}
