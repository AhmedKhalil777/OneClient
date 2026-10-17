import { toCurl, parseCurl } from "./curl.js";
import { type AuthDef, type Collection, type Environment, type HistoryEntry, type KV, type RequestDef, emptyRequest } from "./model.js";
import { exportCollection, exportEnvironment, importCollection, importEnvironment, isPostmanCollection, isPostmanEnvironment, type ImportReport } from "./postman.js";
import { prepare, send, type HttpResponse } from "./runner.js";
import { sessionFor } from "./sessions.js";
import { workspaceFor } from "./store.js";
import { addCollection, addFolder, addRequest, countRequests, duplicate, effectiveAuth, findCollection, locate, newId, pathOf, remove, rename } from "./tree.js";
import { buildScope } from "./vars.js";

type Json = Record<string, unknown>;
type Params = Record<string, unknown>;
export type Handler = (connectionId: string | undefined, p: Params) => Promise<unknown> | unknown;

export class HttpPluginError extends Error {}

const needS = (p: Params, key: string): string => {
  const v = p[key];
  if (typeof v !== "string" || v === "") throw new HttpPluginError(`Missing "${key}".`);
  return v;
};
const optS = (p: Params, key: string): string | undefined => (typeof p[key] === "string" && p[key] !== "" ? (p[key] as string) : undefined);

// ---- request log (the Output panel) ----------------------------------------------------------------------------

export type RequestLogger = (level: "info" | "warn" | "error", message: string, detail?: string) => void;
let requestLog: RequestLogger = () => {};
export const setRequestLogger = (fn: RequestLogger): void => void (requestLog = fn);

const inflight = new Map<string, AbortController>();

function asRequest(v: unknown): RequestDef {
  if (typeof v !== "object" || v === null) throw new HttpPluginError("Missing request.");
  const r = v as Partial<RequestDef>;
  return {
    method: typeof r.method === "string" && r.method ? r.method : "GET",
    url: typeof r.url === "string" ? r.url : "",
    headers: Array.isArray(r.headers) ? (r.headers as KV[]) : [],
    body: r.body && typeof r.body === "object" ? (r.body as RequestDef["body"]) : { mode: "none" },
    auth: r.auth && typeof r.auth === "object" ? (r.auth as AuthDef) : { type: "inherit" },
  };
}

const redactHeaders = (headers: Array<[string, string]>) => headers.map(([k, v]) => (/^(authorization|cookie|x-api-key|proxy-authorization)$/i.test(k) ? `${k}: ••••••` : `${k}: ${v}`));

interface Resolved {
  def: RequestDef;
  auth: AuthDef;
  scope: ReturnType<typeof buildScope>;
}

function resolve(connectionId: string | undefined, p: Params): Resolved {
  const ws = workspaceFor(connectionId).get();
  const def = asRequest(p.request);
  const itemId = optS(p, "itemId");
  const loc = itemId ? locate(ws, itemId) : undefined;
  const scope = buildScope(ws, loc?.collection ?? findCollection(ws, optS(p, "collectionId") ?? ""));
  const auth = loc ? effectiveAuth(loc, def.auth) : def.auth.type === "inherit" ? ({ type: "none" } as AuthDef) : def.auth;
  return { def, auth, scope };
}

function summary(c: Collection) {
  return { id: c.id, name: c.name, description: c.description ?? "", requests: countRequests(c.items) };
}

export const API: Record<string, Handler> = {
  // -- overview for the workspace page
  overview: (cid) => {
    const ws = workspaceFor(cid).get();
    return {
      collections: ws.collections.map(summary),
      environments: ws.environments.map((e) => ({ id: e.id, name: e.name, variables: e.variables.length })),
      activeEnvironmentId: ws.activeEnvironmentId ?? null,
      historyCount: ws.history.length,
      file: workspaceFor(cid).filePath,
    };
  },

  // -- requests
  getRequest: (cid, p) => {
    const ws = workspaceFor(cid).get();
    const loc = locate(ws, needS(p, "id"));
    if (!loc || loc.item.type !== "request") throw new HttpPluginError("That request no longer exists — it may have been deleted.");
    return {
      id: loc.item.id,
      name: loc.item.name,
      description: loc.item.description ?? "",
      request: loc.item.request,
      collectionId: loc.collection.id,
      path: pathOf(loc),
      inheritedAuth: effectiveAuth(loc, { type: "inherit" }),
    };
  },
  saveRequest: (cid, p) => {
    const store = workspaceFor(cid);
    const def = asRequest(p.request);
    store.update((ws) => {
      const loc = locate(ws, needS(p, "id"));
      if (!loc || loc.item.type !== "request") throw new HttpPluginError("That request no longer exists.");
      loc.item.request = def;
      if (optS(p, "name")) loc.item.name = needS(p, "name");
      if (typeof p.description === "string") loc.item.description = p.description;
    });
    return {};
  },

  // -- tree
  create: (cid, p) => {
    const store = workspaceFor(cid);
    return store.update((ws) => {
      const name = needS(p, "name");
      switch (p.kind) {
        case "collection":
          return { id: addCollection(ws, name).id };
        case "folder":
          return { id: addFolder(ws, needS(p, "parentId"), name).id };
        case "request":
          return { id: addRequest(ws, needS(p, "parentId"), name, p.request ? asRequest(p.request) : emptyRequest()).id };
        default:
          throw new HttpPluginError(`Can't create "${String(p.kind)}".`);
      }
    });
  },
  rename: (cid, p) => void workspaceFor(cid).update((ws) => rename(ws, needS(p, "id"), needS(p, "name"))),
  remove: (cid, p) => void workspaceFor(cid).update((ws) => remove(ws, needS(p, "id"))),
  duplicate: (cid, p) => ({ id: workspaceFor(cid).update((ws) => duplicate(ws, needS(p, "id"))) }),

  getCollection: (cid, p) => {
    const c = findCollection(workspaceFor(cid).get(), needS(p, "id"));
    if (!c) throw new HttpPluginError("That collection no longer exists.");
    return { id: c.id, name: c.name, description: c.description ?? "", auth: c.auth, variables: c.variables };
  },
  saveCollection: (cid, p) => {
    workspaceFor(cid).update((ws) => {
      const c = findCollection(ws, needS(p, "id"));
      if (!c) throw new HttpPluginError("That collection no longer exists.");
      if (optS(p, "name")) c.name = needS(p, "name");
      if (typeof p.description === "string") c.description = p.description;
      if (p.auth && typeof p.auth === "object") c.auth = p.auth as AuthDef;
      if (Array.isArray(p.variables)) c.variables = p.variables as KV[];
    });
    return {};
  },

  // -- environments
  saveEnvironment: (cid, p) => {
    const env = p.environment as Environment | undefined;
    if (!env || typeof env.name !== "string" || !env.name.trim()) throw new HttpPluginError("An environment needs a name.");
    return workspaceFor(cid).update((ws) => {
      const clean: Environment = { id: env.id || newId(), name: env.name.trim(), variables: Array.isArray(env.variables) ? env.variables : [] };
      const i = ws.environments.findIndex((e) => e.id === clean.id);
      if (i >= 0) ws.environments[i] = clean;
      else ws.environments.push(clean);
      return { id: clean.id };
    });
  },
  deleteEnvironment: (cid, p) =>
    void workspaceFor(cid).update((ws) => {
      ws.environments = ws.environments.filter((e) => e.id !== needS(p, "id"));
      if (ws.activeEnvironmentId === p.id) ws.activeEnvironmentId = undefined;
    }),
  getEnvironments: (cid) => ({ environments: workspaceFor(cid).get().environments, activeEnvironmentId: workspaceFor(cid).get().activeEnvironmentId ?? null }),
  setActiveEnvironment: (cid, p) =>
    void workspaceFor(cid).update((ws) => {
      ws.activeEnvironmentId = typeof p.id === "string" && ws.environments.some((e) => e.id === p.id) ? p.id : undefined;
    }),

  /** Variables in effect for a request (for the "Variables" hint and `{{` highlighting). */
  scope: (cid, p) => {
    const ws = workspaceFor(cid).get();
    const loc = optS(p, "itemId") ? locate(ws, needS(p, "itemId")) : undefined;
    const col = loc?.collection ?? findCollection(ws, optS(p, "collectionId") ?? "");
    const env = ws.environments.find((e) => e.id === ws.activeEnvironmentId);
    const out: Array<{ key: string; value: string; source: string; secret: boolean }> = [];
    const seen = new Map<string, number>();
    const add = (list: Array<KV & { secret?: boolean }>, source: string) => {
      for (const v of list) {
        if (!v.enabled || !v.key) continue;
        const at = seen.get(v.key);
        const row = { key: v.key, value: v.value, source, secret: v.secret === true };
        if (at !== undefined) out[at] = row;
        else {
          seen.set(v.key, out.length);
          out.push(row);
        }
      }
    };
    if (col) add(col.variables, `collection ${col.name}`);
    if (env) add(env.variables, `environment ${env.name}`);
    return out;
  },

  // -- sending
  send: async (cid, p) => {
    const store = workspaceFor(cid);
    const { def, auth, scope } = resolve(cid, p);
    const prepared = prepare(def, scope, auth);
    if (!prepared.url.replace(/^https?:\/\//, "")) throw new HttpPluginError("Enter a URL first.");
    const cfg = sessionFor(cid);
    const controller = new AbortController();
    const requestId = optS(p, "requestId");
    if (requestId) inflight.set(requestId, controller);

    const entry: HistoryEntry = { id: newId(), time: Date.now(), method: prepared.method, url: prepared.url, request: def };
    let response: HttpResponse | undefined;
    try {
      response = await send(prepared, {
        timeoutMs: Math.max(1, cfg.timeoutSeconds ?? 30) * 1000,
        followRedirects: cfg.followRedirects !== false,
        allowSelfSigned: cfg.allowSelfSignedCertificate === true,
        signal: controller.signal,
      });
      entry.status = response.status;
      entry.ms = response.ms;
      requestLog(
        response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
        `${prepared.method} ${prepared.url} → ${response.status} ${response.statusText} (${response.ms} ms, ${response.size} B)`,
        [`Request headers:\n${redactHeaders(prepared.headers).join("\n")}`, prepared.bodyText ? `Request body:\n${prepared.bodyText.slice(0, 4000)}` : "", `Response headers:\n${response.headers.map(([k, v]) => `${k}: ${v}`).join("\n")}`]
          .filter(Boolean)
          .join("\n\n"),
      );
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      requestLog("error", `${prepared.method} ${prepared.url} → ${entry.error}`);
      throw err;
    } finally {
      if (requestId) inflight.delete(requestId);
      store.update((ws) => void ws.history.unshift(entry));
    }
    return {
      response,
      sent: { method: prepared.method, url: prepared.url, headers: redactHeaders(prepared.headers), body: prepared.bodyText ?? null },
      unresolved: prepared.unresolved,
    };
  },
  cancel: (_cid, p) => {
    inflight.get(needS(p, "requestId"))?.abort();
    return {};
  },
  toCurl: (cid, p) => {
    const { def, auth, scope } = resolve(cid, p);
    const r = prepare(def, scope, auth);
    return toCurl({ method: r.method, url: r.url, headers: r.headers, body: r.bodyText, form: r.form });
  },

  // -- history
  history: (cid) => workspaceFor(cid).get().history.map(({ id, time, method, url, status, ms, error }) => ({ id, time, method, url, status, ms, error })),
  historyEntry: (cid, p) => {
    const e = workspaceFor(cid).get().history.find((h) => h.id === needS(p, "id"));
    if (!e) throw new HttpPluginError("That history entry is gone.");
    return e;
  },
  clearHistory: (cid) => void workspaceFor(cid).update((ws) => void (ws.history = [])),

  // -- import / export
  importText: (cid, p) => {
    const text = needS(p, "text").trim();
    const store = workspaceFor(cid);
    const result: { kind: string; name: string; report?: ImportReport; notes?: string[]; id?: string; items: Array<{ kind: string; name: string; id: string }> } = { kind: "", name: "", items: [] };

    if (/^curl\b/i.test(text)) {
      const { request, notes } = parseCurl(text);
      store.update((ws) => {
        let col = ws.collections.find((c) => c.name === "Imported requests");
        if (!col) col = addCollection(ws, "Imported requests");
        let name = `${request.method} ${request.url}`.slice(0, 80);
        try {
          const u = new URL(request.url);
          name = `${request.method} ${u.pathname === "/" ? u.host : u.pathname}`;
        } catch {
          /* keep the raw name */
        }
        const item = addRequest(ws, col.id, name, request);
        result.kind = "curl";
        result.name = name;
        result.id = item.id;
        result.notes = notes;
        result.items.push({ kind: "request", name, id: item.id });
      });
      return result;
    }

    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      throw new HttpPluginError(`That isn't JSON or a curl command: ${err instanceof Error ? err.message : String(err)}`);
    }

    const docs: unknown[] = typeof doc === "object" && doc !== null && Array.isArray((doc as Json).collections) ? [...((doc as Json).collections as unknown[]), ...(Array.isArray((doc as Json).environments) ? ((doc as Json).environments as unknown[]) : [])] : [doc];
    const total: ImportReport = { requests: 0, folders: 0, scripts: 0, warnings: [] };
    store.update((ws) => {
      for (const d of docs) {
        if (isPostmanCollection(d)) {
          const { collection, report } = importCollection(d);
          ws.collections.push(collection);
          total.requests += report.requests;
          total.folders += report.folders;
          total.scripts += report.scripts;
          total.warnings.push(...report.warnings);
          result.items.push({ kind: "collection", name: collection.name, id: collection.id });
        } else if (isPostmanEnvironment(d)) {
          const env = importEnvironment(d);
          ws.environments.push(env);
          result.items.push({ kind: "environment", name: env.name, id: env.id });
        } else {
          total.warnings.push("Skipped a document that is neither a Postman collection nor an environment.");
        }
      }
    });
    if (result.items.length === 0) throw new HttpPluginError("Nothing to import — that doesn't look like a Postman collection (v2.0 / v2.1), a Postman environment, or a curl command.");
    result.kind = result.items.length === 1 ? result.items[0]!.kind : "mixed";
    result.name = result.items.map((i) => i.name).join(", ");
    result.report = total;
    return result;
  },
  exportCollection: (cid, p) => {
    const c = findCollection(workspaceFor(cid).get(), needS(p, "id"));
    if (!c) throw new HttpPluginError("That collection no longer exists.");
    return { fileName: `${c.name.replace(/[^\w.-]+/g, "_")}.postman_collection.json`, json: JSON.stringify(exportCollection(c), null, 2) };
  },
  exportEnvironment: (cid, p) => {
    const e = workspaceFor(cid).get().environments.find((x) => x.id === needS(p, "id"));
    if (!e) throw new HttpPluginError("That environment no longer exists.");
    return { fileName: `${e.name.replace(/[^\w.-]+/g, "_")}.postman_environment.json`, json: JSON.stringify(exportEnvironment(e), null, 2) };
  },
};

export type ApiResult = { ok: true; data: unknown } | { ok: false; error: string };

/** Runs one operation, turning every failure into `{ ok: false, error }` — views show it instead of crashing. */
export async function callApi(connectionId: string | undefined, method: string, params: Params): Promise<ApiResult> {
  const handler = API[method];
  if (!handler) return { ok: false, error: `Unknown operation "${method}".` };
  try {
    return { ok: true, data: await handler(connectionId, params) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
