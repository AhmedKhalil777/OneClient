import type { AuthDef, BodyDef, Collection, Environment, FormField, Item, KV, RawLanguage, RequestDef } from "./model.js";
import { newId } from "./tree.js";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface ImportReport {
  requests: number;
  folders: number;
  /** Postman pre-request / test scripts — they are kept out (oneClient doesn't run scripts). */
  scripts: number;
  warnings: string[];
}

// ---- Postman → oneClient --------------------------------------------------------------------------------------

/** Postman auth blocks hold their fields either as `[{key, value}]` (v2.1) or as a plain object (v2.0). */
function authFields(block: unknown): Record<string, string> {
  if (Array.isArray(block)) return Object.fromEntries(block.filter(isObj).map((e) => [str(e.key), str(e.value)]));
  if (isObj(block)) return Object.fromEntries(Object.entries(block).map(([k, v]) => [k, str(v)]));
  return {};
}

function importAuth(auth: unknown, report: ImportReport, where: string): AuthDef | undefined {
  if (!isObj(auth)) return undefined;
  const type = str(auth.type);
  switch (type) {
    case "noauth":
      return { type: "none" };
    case "bearer":
      return { type: "bearer", token: authFields(auth.bearer).token ?? "" };
    case "basic": {
      const f = authFields(auth.basic);
      return { type: "basic", username: f.username ?? "", password: f.password ?? "" };
    }
    case "apikey": {
      const f = authFields(auth.apikey);
      return { type: "apikey", key: f.key ?? "", value: f.value ?? "", in: f.in === "query" ? "query" : "header" };
    }
    default:
      report.warnings.push(`${where}: "${type}" authentication isn't supported — set it up by hand.`);
      return { type: "none" };
  }
}

const importKV = (list: unknown): KV[] =>
  arr(list)
    .filter(isObj)
    .map((h) => ({ key: str(h.key), value: str(h.value), enabled: h.disabled !== true, ...(h.description ? { description: str(isObj(h.description) ? h.description.content : h.description) } : {}) }));

function importUrl(url: unknown): string {
  if (typeof url === "string") return url;
  if (!isObj(url)) return "";
  if (typeof url.raw === "string" && url.raw) return url.raw;
  const host = Array.isArray(url.host) ? url.host.join(".") : str(url.host);
  const path = Array.isArray(url.path) ? url.path.map(str).join("/") : str(url.path);
  const query = arr(url.query)
    .filter(isObj)
    .filter((q) => q.disabled !== true)
    .map((q) => `${str(q.key)}=${str(q.value)}`)
    .join("&");
  return `${url.protocol ? `${str(url.protocol)}://` : ""}${host}${url.port ? `:${str(url.port)}` : ""}${path ? `/${path}` : ""}${query ? `?${query}` : ""}`;
}

function importBody(body: unknown, headers: KV[], report: ImportReport, where: string): BodyDef {
  if (!isObj(body)) return { mode: "none" };
  switch (str(body.mode)) {
    case "raw": {
      const lang = str(((body.options as Json | undefined)?.raw as Json | undefined)?.language);
      const language: RawLanguage = (["json", "xml", "html", "javascript"] as const).find((l) => l === lang) ?? "text";
      return { mode: "raw", raw: str(body.raw), language };
    }
    case "urlencoded":
      return { mode: "urlencoded", fields: importKV(body.urlencoded) };
    case "formdata":
      return {
        mode: "formdata",
        fields: arr(body.formdata)
          .filter(isObj)
          .map((f): FormField => {
            const file = str(f.type) === "file";
            return { key: str(f.key), value: file ? str(Array.isArray(f.src) ? f.src[0] : f.src) : str(f.value), enabled: f.disabled !== true, type: file ? "file" : "text" };
          }),
      };
    case "graphql": {
      const g = isObj(body.graphql) ? body.graphql : {};
      let variables: unknown = {};
      try {
        variables = g.variables ? JSON.parse(str(g.variables)) : {};
      } catch {
        variables = {};
      }
      if (!headers.some((h) => h.key.toLowerCase() === "content-type")) headers.push({ key: "Content-Type", value: "application/json", enabled: true });
      return { mode: "raw", language: "json", raw: JSON.stringify({ query: str(g.query), variables }, null, 2) };
    }
    case "file":
    case "binary":
      report.warnings.push(`${where}: a "binary file" body can't be imported.`);
      return { mode: "none" };
    default:
      return { mode: "none" };
  }
}

function importRequest(raw: unknown, name: string, report: ImportReport): RequestDef {
  const r: RequestDef = { method: "GET", url: "", headers: [], body: { mode: "none" }, auth: { type: "inherit" } };
  if (typeof raw === "string") {
    r.url = raw;
    return r;
  }
  if (!isObj(raw)) return r;
  r.method = str(raw.method).toUpperCase() || "GET";
  r.url = importUrl(raw.url);
  r.headers = importKV(raw.header);
  r.body = importBody(raw.body, r.headers, report, name);
  r.auth = importAuth(raw.auth, report, name) ?? { type: "inherit" };
  return r;
}

function importItems(list: unknown, report: ImportReport): Item[] {
  const out: Item[] = [];
  for (const raw of arr(list)) {
    if (!isObj(raw)) continue;
    const name = str(raw.name) || "Untitled";
    report.scripts += arr(raw.event).length;
    const description = isObj(raw.description) ? str(raw.description.content) : str(raw.description);
    if (Array.isArray(raw.item)) {
      report.folders++;
      const auth = importAuth(raw.auth, report, name);
      out.push({ type: "folder", id: newId(), name, ...(description ? { description } : {}), ...(auth ? { auth } : {}), items: importItems(raw.item, report) });
    } else {
      report.requests++;
      out.push({ type: "request", id: newId(), name, ...(description ? { description } : {}), request: importRequest(raw.request, name, report) });
    }
  }
  return out;
}

export function isPostmanCollection(doc: unknown): doc is Json {
  return isObj(doc) && isObj(doc.info) && Array.isArray(doc.item);
}

export function isPostmanEnvironment(doc: unknown): doc is Json {
  return isObj(doc) && Array.isArray(doc.values) && !Array.isArray(doc.item);
}

export function importCollection(doc: Json): { collection: Collection; report: ImportReport } {
  const report: ImportReport = { requests: 0, folders: 0, scripts: 0, warnings: [] };
  const info = doc.info as Json;
  report.scripts += arr(doc.event).length;
  const description = isObj(info.description) ? str(info.description.content) : str(info.description);
  const collection: Collection = {
    id: newId(),
    name: str(info.name) || "Imported collection",
    ...(description ? { description } : {}),
    auth: importAuth(doc.auth, report, "collection") ?? { type: "none" },
    variables: arr(doc.variable)
      .filter(isObj)
      .map((v) => ({ key: str(v.key ?? v.id), value: str(v.value ?? v.default), enabled: v.disabled !== true })),
    items: importItems(doc.item, report),
  };
  return { collection, report };
}

export function importEnvironment(doc: Json): Environment {
  const scope = str(doc._postman_variable_scope);
  const name = str(doc.name) || "Imported environment";
  return {
    id: newId(),
    name: scope === "globals" ? `${name} (globals)` : name,
    variables: arr(doc.values)
      .filter(isObj)
      .map((v) => ({ key: str(v.key), value: str(v.value), enabled: v.enabled !== false, ...(str(v.type) === "secret" ? { secret: true } : {}) })),
  };
}

// ---- oneClient → Postman v2.1 -----------------------------------------------------------------------------------

const SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

const exportKV = (list: KV[]) => list.map((h) => ({ key: h.key, value: h.value, ...(h.enabled ? {} : { disabled: true }), ...(h.description ? { description: h.description } : {}) }));

function exportAuth(a: AuthDef): Json | undefined {
  const fields = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value, type: "string" }));
  switch (a.type) {
    case "inherit":
      return undefined;
    case "none":
      return { type: "noauth" };
    case "bearer":
      return { type: "bearer", bearer: fields({ token: a.token }) };
    case "basic":
      return { type: "basic", basic: fields({ username: a.username, password: a.password }) };
    case "apikey":
      return { type: "apikey", apikey: fields({ key: a.key, value: a.value, in: a.in }) };
  }
}

function exportUrl(url: string): Json {
  const raw = url;
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(url);
  if (!m) return { raw };
  const [, protocol, authority = "", path = "", query] = m;
  const [hostPart = "", port] = authority.split(/:(?=\d+$)/);
  return {
    raw,
    ...(protocol ? { protocol } : {}),
    host: hostPart ? hostPart.split(".") : [],
    ...(port ? { port } : {}),
    path: path.split("/").filter(Boolean),
    ...(query ? { query: query.split("&").map((p) => ({ key: p.split("=")[0] ?? "", value: p.includes("=") ? p.slice(p.indexOf("=") + 1) : "" })) } : {}),
  };
}

function exportBody(b: BodyDef): Json | undefined {
  switch (b.mode) {
    case "none":
      return undefined;
    case "raw":
      return { mode: "raw", raw: b.raw, options: { raw: { language: b.language } } };
    case "urlencoded":
      return { mode: "urlencoded", urlencoded: exportKV(b.fields) };
    case "formdata":
      return {
        mode: "formdata",
        formdata: b.fields.map((f) => (f.type === "file" ? { key: f.key, type: "file", src: f.value, ...(f.enabled ? {} : { disabled: true }) } : { key: f.key, value: f.value, type: "text", ...(f.enabled ? {} : { disabled: true }) })),
      };
  }
}

function exportItems(items: Item[]): Json[] {
  return items.map((it): Json => {
    if (it.type === "folder") {
      const auth = it.auth ? exportAuth(it.auth) : undefined;
      return { name: it.name, ...(it.description ? { description: it.description } : {}), ...(auth ? { auth } : {}), item: exportItems(it.items) };
    }
    const r = it.request;
    const auth = exportAuth(r.auth);
    const body = exportBody(r.body);
    return {
      name: it.name,
      request: { method: r.method, header: exportKV(r.headers), ...(body ? { body } : {}), ...(auth ? { auth } : {}), url: exportUrl(r.url), ...(it.description ? { description: it.description } : {}) },
      response: [],
    };
  });
}

/** A Postman Collection v2.1 document — opens in Postman, Insomnia, Bruno, Hoppscotch… */
export function exportCollection(c: Collection): Json {
  const auth = exportAuth(c.auth);
  return {
    info: { _postman_id: c.id, name: c.name, ...(c.description ? { description: c.description } : {}), schema: SCHEMA },
    item: exportItems(c.items),
    ...(auth ? { auth } : {}),
    variable: c.variables.map((v) => ({ key: v.key, value: v.value, ...(v.enabled ? {} : { disabled: true }) })),
  };
}

export function exportEnvironment(e: Environment): Json {
  return {
    id: e.id,
    name: e.name,
    values: e.variables.map((v) => ({ key: v.key, value: v.value, enabled: v.enabled, type: v.secret ? "secret" : "default" })),
    _postman_variable_scope: "environment",
  };
}
