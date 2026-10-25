import { randomInt, randomUUID } from "node:crypto";
import type { PreviewResult } from "@oneclient/plugin-api";
import { type HttpFileRequest, type ParsedHttpFile, parseHttpFile } from "./httpfile.js";
import { type HttpResponse, type PreparedRequest, send } from "./runner.js";

/**
 * Sends one request of an `.http` file and renders the response as HTML for the editor's result pane.
 * Supports file variables (`@host = …`), `{{$guid}}`-style dynamic values, `{{$processEnv NAME}}`, and
 * chaining: `# @name login` lets a later request use `{{login.response.body.$.token}}` (the named request is
 * sent first if it hasn't been yet in this session).
 */

interface Stored {
  status: number;
  headers: Array<[string, string]>;
  body: string;
  json: unknown;
  hasJson: boolean;
}

/** Responses of named requests, per document name, for this session. */
const sessions = new Map<string, Map<string, Stored>>();

export function resetSession(fileName?: string): void {
  if (fileName) sessions.delete(fileName);
  else sessions.clear();
}

const REFERENCE = /\{\{\s*([A-Za-z_][\w-]*)\.response\.(body|headers)\.([^}]+?)\s*\}\}/g;

// ---- variables ----------------------------------------------------------------------------------------------------

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `{{$timestamp -1 h}}` → an offset in milliseconds (0 when absent). */
function offsetMs(args: string[]): number {
  const n = Number(args[0]);
  const unit = UNITS[args[1] ?? "s"];
  return Number.isFinite(n) && unit ? n * unit : 0;
}

function dynamicValue(expr: string): string | undefined {
  const [name, ...args] = expr.trim().split(/\s+/);
  switch (name) {
    case "$guid":
    case "$uuid":
      return randomUUID();
    case "$randomInt": {
      const min = Number(args[0] ?? 0);
      const max = Number(args[1] ?? 1000);
      return String(randomInt(Math.min(min, max), Math.max(min, max) + 1));
    }
    case "$timestamp":
      return String(Math.floor((Date.now() + offsetMs(args)) / 1000));
    case "$datetime":
    case "$localDatetime": {
      const d = new Date(Date.now() + offsetMs(args.slice(1)));
      return args[0] === "rfc1123" ? d.toUTCString() : d.toISOString();
    }
    case "$processEnv":
      return args[0] ? process.env[args[0]] : undefined;
    default:
      return undefined;
  }
}

/** A small JSONPath: `$`, `$.a.b`, `$.items[0].id`, `$['key']`. */
export function jsonPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  const rest = path.trim().replace(/^\$/, "");
  const re = /\.([\w$-]+)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]/g;
  let consumed = 0;
  for (const m of rest.matchAll(re)) {
    if (m.index !== consumed) return undefined;
    consumed += m[0].length;
    const key = m[1] ?? m[3] ?? m[4];
    if (cur === null || typeof cur !== "object") return undefined;
    cur = key !== undefined ? (cur as Record<string, unknown>)[key] : (cur as unknown[])[Number(m[2])];
  }
  return consumed === rest.length ? cur : undefined;
}

export interface Scope {
  vars: Map<string, string>;
  responses: Map<string, Stored>;
}

/** Replaces `{{…}}`; what can't be resolved stays as written and is reported. */
export function interpolate(text: string, scope: Scope, unresolved: Set<string>): string {
  return text.replace(/\{\{\s*([^{}\n]+?)\s*\}\}/g, (whole, expr: string) => {
    const ref = /^([A-Za-z_][\w-]*)\.response\.(body|headers)\.(.+)$/.exec(expr);
    if (ref) {
      const r = scope.responses.get(ref[1]!);
      if (!r) {
        unresolved.add(expr);
        return whole;
      }
      if (ref[2] === "headers") {
        const h = r.headers.find(([k]) => k.toLowerCase() === ref[3]!.toLowerCase());
        if (h) return h[1];
      } else if (ref[3] === "*") return r.body;
      else if (r.hasJson) {
        const v = jsonPath(r.json, ref[3]!);
        if (v !== undefined) return typeof v === "string" ? v : JSON.stringify(v);
      }
      unresolved.add(expr);
      return whole;
    }
    const own = scope.vars.get(expr);
    if (own !== undefined) return own;
    const dyn = expr.startsWith("$") ? dynamicValue(expr) : undefined;
    if (dyn !== undefined) return dyn;
    unresolved.add(expr);
    return whole;
  });
}

/** File variables in order — each may use the ones above it and the dynamic values. */
function fileScope(parsed: ParsedHttpFile, responses: Map<string, Stored>): Scope {
  const scope: Scope = { vars: new Map(), responses };
  for (const v of parsed.variables) scope.vars.set(v.name, interpolate(v.value, scope, new Set()));
  return scope;
}

// ---- sending ------------------------------------------------------------------------------------------------------

const has = (headers: Array<[string, string]>, name: string) => headers.some(([k]) => k.toLowerCase() === name);

/** REST Client's convenience: `Authorization: Basic user:pass` / `Basic user pass` → base64. */
function fixBasicAuth(headers: Array<[string, string]>): void {
  for (const h of headers) {
    const m = /^Basic\s+(.+)$/i.exec(h[1]);
    if (h[0].toLowerCase() !== "authorization" || !m) continue;
    const payload = m[1]!.trim();
    if (/^[A-Za-z0-9+/=]{4,}$/.test(payload) && !payload.includes(":")) continue; // already encoded
    h[1] = `Basic ${Buffer.from(payload.includes(":") ? payload : payload.replace(/\s+/, ":")).toString("base64")}`;
  }
}

interface Prepared {
  request: PreparedRequest;
  unresolved: string[];
}

function prepareRequest(r: HttpFileRequest, scope: Scope): Prepared {
  const unresolved = new Set<string>();
  const sub = (s: string) => interpolate(s, scope, unresolved);
  let url = sub(r.url).trim();
  if (/^\//.test(url)) throw new Error(`The URL "${url}" has no host. Define one at the top of the file, e.g. "@host = http://localhost:3000", and write {{host}}${url}.`);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  const headers: Array<[string, string]> = r.headers.map(([k, v]) => [sub(k), sub(v)]);
  fixBasicAuth(headers);
  let body: Buffer | undefined;
  let bodyText: string | undefined;
  if (r.body) {
    if (/^<\s+\S/.test(r.body.trim())) throw new Error("Sending a body from a file (`< ./file`) isn't supported yet — paste the content into the request.");
    bodyText = sub(r.body);
    body = Buffer.from(bodyText, "utf-8");
    if (!has(headers, "content-type") && /^\s*[[{]/.test(bodyText)) headers.push(["Content-Type", "application/json"]);
  }
  return { request: { method: r.method, url, headers, body, bodyText, unresolved: [...unresolved] }, unresolved: [...unresolved] };
}

function store(r: HttpResponse): Stored {
  let json: unknown;
  let hasJson = false;
  if (!r.binary && /json|\+json/i.test(r.contentType)) {
    try {
      json = JSON.parse(r.body);
      hasJson = true;
    } catch {
      /* not JSON after all */
    }
  }
  return { status: r.status, headers: r.headers, body: r.binary ? "" : r.body, json, hasJson };
}

/** Sends the request; named requests it depends on are sent first (once per session). */
async function execute(parsed: ParsedHttpFile, req: HttpFileRequest, responses: Map<string, Stored>, trail: string[]): Promise<{ response: HttpResponse; prepared: Prepared }> {
  // Dependencies: {{name.response…}} where `name` is another request of this file we haven't sent yet.
  const text = [req.url, req.body, ...req.headers.flat()].join("\n");
  for (const m of text.matchAll(REFERENCE)) {
    const dep = parsed.requests.find((x) => x.name === m[1]);
    if (!dep || dep === req || responses.has(dep.name!)) continue;
    if (trail.includes(dep.name!) || trail.length > 5) throw new Error(`"${req.name ?? req.label}" and "${dep.name}" depend on each other.`);
    const { response } = await execute(parsed, dep, responses, [...trail, req.name ?? `#${req.index}`]);
    responses.set(dep.name!, store(response));
  }
  const prepared = prepareRequest(req, fileScope(parsed, responses));
  const response = await send(prepared.request, { timeoutMs: 60_000, followRedirects: !req.noRedirect, allowSelfSigned: req.insecure });
  return { response, prepared };
}

// ---- rendering ----------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const bytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

/** Pretty JSON with the preview's syntax colors. */
function colorJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? "";
  return esc(text).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, (m, str: string | undefined, colon: string | undefined, lit: string | undefined) => {
    if (str) return `<span class="${colon ? "k" : "s"}">${str}</span>${colon ?? ""}`;
    if (lit) return `<span class="l">${m}</span>`;
    return `<span class="n">${m}</span>`;
  });
}

const CSS = `
.hf{font-size:13px;line-height:1.5}
.hf .top{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 10px}
.hf .st{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:700;background:rgba(128,128,128,.25)}
.hf .st.ok{background:rgba(63,185,80,.22);color:#3fb950}
.hf .st.redir{background:rgba(88,166,255,.2);color:#58a6ff}
.hf .st.warn{background:rgba(210,153,34,.22);color:#d29922}
.hf .st.err{background:rgba(248,81,73,.22);color:#f85149}
.hf .meta{opacity:.7}
.hf .url{font-family:var(--oc-editor-font-family,Consolas,monospace);opacity:.85;word-break:break-all;margin:0 0 10px}
.hf details{margin:0 0 10px}
.hf summary{cursor:pointer;opacity:.8}
.hf table{border-collapse:collapse;margin-top:6px;width:100%}
.hf td{padding:2px 10px 2px 0;vertical-align:top;word-break:break-all}
.hf td:first-child{opacity:.7;white-space:nowrap}
.hf pre{margin:0;padding:10px 12px;border-radius:8px;background:rgba(128,128,128,.12);overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--oc-editor-font-family,Consolas,monospace);font-size:12.5px}
.hf .k{color:var(--oc-syntax-property,#9cdcfe)}.hf .s{color:var(--oc-syntax-string,#ce9178)}.hf .n{color:var(--oc-syntax-number,#b5cea8)}.hf .l{color:var(--oc-syntax-keyword,#569cd6)}
.hf img{max-width:100%;border-radius:6px}
.hf .warn-box{margin:0 0 10px;padding:6px 10px;border-radius:8px;background:rgba(210,153,34,.15);color:#d29922}
.hf .err-box{padding:10px 12px;border-radius:8px;background:rgba(248,81,73,.14);color:#f85149;white-space:pre-wrap}
`;

function renderResponse(req: HttpFileRequest, p: Prepared, r: HttpResponse): string {
  const cls = r.status >= 500 ? "err" : r.status >= 400 ? "warn" : r.status >= 300 ? "redir" : "ok";
  let body: string;
  const ct = r.contentType.toLowerCase();
  if (r.binary) {
    body = ct.startsWith("image/") && !r.truncated ? `<img alt="response image" src="data:${esc(ct.split(";")[0]!)};base64,${r.body}" />` : `<pre>(binary content, ${bytes(r.size)})</pre>`;
  } else {
    let parsed: unknown;
    let isJson = false;
    if (/json/.test(ct) || /^\s*[[{]/.test(r.body)) {
      try {
        parsed = JSON.parse(r.body);
        isJson = true;
      } catch {
        /* show it as text */
      }
    }
    body = r.body ? `<pre>${isJson ? colorJson(parsed) : esc(r.body)}</pre>` : `<div class="meta">(empty body)</div>`;
  }
  const sent = [`${p.request.method} ${p.request.url}`, ...p.request.headers.map(([k, v]) => `${k}: ${/^authorization$/i.test(k) ? v.replace(/^(\S+\s+).*/, "$1…") : v}`), ...(p.request.bodyText ? ["", p.request.bodyText] : [])].join("\n");
  return `<div class="hf">
<div class="top"><span class="st ${cls}">${r.status} ${esc(r.statusText)}</span><span class="meta">${r.ms} ms · ${bytes(r.size)}${r.contentType ? ` · ${esc(r.contentType.split(";")[0]!)}` : ""}</span></div>
<div class="url">${esc(req.method)} ${esc(r.url)}</div>
${p.unresolved.length ? `<div class="warn-box">Not defined, sent as written: ${p.unresolved.map((u) => `<code>{{${esc(u)}}}</code>`).join(", ")}</div>` : ""}
${r.redirects.length ? `<details><summary>${r.redirects.length} redirect${r.redirects.length > 1 ? "s" : ""}</summary><pre>${esc(r.redirects.join("\n"))}</pre></details>` : ""}
<details><summary>Response headers (${r.headers.length})</summary><table>${r.headers.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></details>
<details><summary>Request sent</summary><pre>${esc(sent)}</pre></details>
${body}${r.truncated ? `<div class="meta">The body was cut at 5 MB.</div>` : ""}
</div>`;
}

const errorCard = (message: string): PreviewResult => ({ ok: true, html: `<div class="hf"><div class="err-box">${esc(message)}</div></div>`, css: CSS });

/** Runs request number `index` of the document and returns the result pane's HTML. */
export async function runHttpFileRequest(text: string, fileName: string, index: number): Promise<PreviewResult> {
  const parsed = parseHttpFile(text);
  const req = parsed.requests[index];
  if (!req) return errorCard("That request is no longer in the file.");
  const responses = sessions.get(fileName) ?? new Map<string, Stored>();
  sessions.set(fileName, responses);
  try {
    const { response, prepared } = await execute(parsed, req, responses, []);
    if (req.name) responses.set(req.name, store(response));
    return { ok: true, html: renderResponse(req, prepared, response), css: CSS };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorCard(req.insecure || !/self.signed|certificate/i.test(message) ? message : `${message}\n\nFor a dev server with a self-signed certificate, add the line  # @insecure  above the request.`);
  }
}
