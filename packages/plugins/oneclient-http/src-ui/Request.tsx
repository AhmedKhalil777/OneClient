import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeatureEditor } from "@oneclient/editor-kit/editor";
import { type AuthDef, type FormField, type KV, METHODS, type RawLanguage, type RequestDef } from "../src/model.js";
import { Modal, api, copy, qs, useToast } from "./kit.js";
import { AuthEditor, KVTable, formatBytes, methodClass, newKV, statusTone } from "./parts.js";

type Tab = "params" | "headers" | "body" | "auth" | "vars";
type ResTab = "body" | "headers" | "cookies" | "sent";

interface Loaded {
  id: string;
  name: string;
  path: string[];
  inheritedAuth: AuthDef;
  request: RequestDef;
}

interface Response {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  cookies: string[];
  ms: number;
  size: number;
  contentType: string;
  body: string;
  binary: boolean;
  truncated: boolean;
  url: string;
  redirects: string[];
}
interface SendResult {
  response: Response;
  sent: { method: string; url: string; headers: string[]; body: string | null };
  unresolved: string[];
}
interface ScopeVar {
  key: string;
  value: string;
  source: string;
  secret: boolean;
}

const LANGS: Array<[RawLanguage, string, string]> = [
  ["json", "JSON", "json"],
  ["text", "Text", "txt"],
  ["xml", "XML", "xml"],
  ["html", "HTML", "html"],
  ["javascript", "JavaScript", "js"],
];

// ---- URL <-> query parameter rows ---------------------------------------------------------------------------

function splitUrl(url: string): { base: string; query: string } {
  const q = url.indexOf("?");
  return q < 0 ? { base: url, query: "" } : { base: url.slice(0, q), query: url.slice(q + 1) };
}
const parseQuery = (query: string): KV[] =>
  query
    .split("&")
    .filter((p) => p !== "")
    .map((p) => {
      const i = p.indexOf("=");
      return { key: i < 0 ? p : p.slice(0, i), value: i < 0 ? "" : p.slice(i + 1), enabled: true };
    });
const buildQuery = (rows: KV[]): string => rows.map((r) => (r.value === "" && !r.key.includes("=") ? r.key : `${r.key}=${r.value}`)).join("&");

const PLACEHOLDER = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;
function usedVariables(r: RequestDef): string[] {
  const texts = [r.url, ...r.headers.filter((h) => h.enabled).flatMap((h) => [h.key, h.value])];
  if (r.body.mode === "raw") texts.push(r.body.raw);
  else if (r.body.mode !== "none") texts.push(...r.body.fields.filter((f) => f.enabled).flatMap((f) => [f.key, f.value]));
  const a = r.auth;
  if (a.type === "bearer") texts.push(a.token);
  else if (a.type === "basic") texts.push(a.username, a.password);
  else if (a.type === "apikey") texts.push(a.key, a.value);
  return [...new Set(texts.flatMap((t) => [...t.matchAll(PLACEHOLDER)].map((m) => m[1]!)))];
}

function extensionFor(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("html")) return "html";
  if (ct.includes("markdown")) return "md";
  if (ct.includes("javascript")) return "js";
  if (ct.includes("css")) return "css";
  return "txt";
}

/** Request builder + response viewer for one saved request (opened from the explorer). */
export function RequestView() {
  const id = qs.get("id") ?? "";
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [req, setReq] = useState<RequestDef | null>(null);
  const [saved, setSaved] = useState("");
  const [tab, setTab] = useState<Tab>("params");
  const [disabledParams, setDisabledParams] = useState<KV[]>([]);
  const [environments, setEnvironments] = useState<Array<{ id: string; name: string }>>([]);
  const [activeEnv, setActiveEnv] = useState<string>("");
  const [scope, setScope] = useState<ScopeVar[]>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [sendError, setSendError] = useState("");
  const [resTab, setResTab] = useState<ResTab>("body");
  const [pretty, setPretty] = useState(true);
  const [dialog, setDialog] = useState<React.ReactNode>(null);
  const [toast, say] = useToast();
  const requestId = useRef("");
  const sendRef = useRef<() => void>(() => {});
  const saveRef = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    const r = await api<Loaded & { request: RequestDef }>("getRequest", { id });
    if (!r.ok) return setError(r.error);
    setLoaded(r.data);
    setReq(r.data.request);
    setSaved(JSON.stringify(r.data.request));
  }, [id]);

  const loadEnv = useCallback(async () => {
    const e = await api<{ environments: Array<{ id: string; name: string }>; activeEnvironmentId: string | null }>("getEnvironments");
    if (e.ok) {
      setEnvironments(e.data.environments);
      setActiveEnv(e.data.activeEnvironmentId ?? "");
    }
    const s = await api<ScopeVar[]>("scope", { itemId: id });
    if (s.ok) setScope(s.data as unknown as ScopeVar[]);
  }, [id]);

  useEffect(() => {
    void load();
    void loadEnv();
  }, [load, loadEnv]);

  const dirty = req !== null && JSON.stringify(req) !== saved;
  useEffect(() => {
    window.oneclientView.setDirty(dirty);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!req) return;
    const r = await api("saveRequest", { id, request: req });
    if (!r.ok) return say(r.error, true);
    setSaved(JSON.stringify(req));
    say("Saved.");
  }, [req, id, say]);

  const send = useCallback(async () => {
    if (!req || sending) return;
    setSending(true);
    setSendError("");
    requestId.current = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const r = await api<SendResult>("send", { request: req, itemId: id, requestId: requestId.current });
    setSending(false);
    if (!r.ok) {
      setResult(null);
      setSendError(r.error);
    } else {
      setResult(r.data);
      setResTab("body");
    }
  }, [req, sending, id]);

  sendRef.current = () => void send();
  saveRef.current = () => void save();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        sendRef.current();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const unknown = useMemo(() => (req ? usedVariables(req).filter((n) => !n.startsWith("$") && !scope.some((s) => s.key === n)) : []), [req, scope]);

  if (error) return <div className="kc-message kc-error">{error}</div>;
  if (!req || !loaded) return <div className="kc-message">Loading…</div>;

  const patch = (p: Partial<RequestDef>) => setReq({ ...req, ...p });
  const { base, query } = splitUrl(req.url);
  const paramRows: KV[] = [...parseQuery(query), ...disabledParams.map((p) => ({ ...p, enabled: false }))];
  const setParams = (rows: KV[]) => {
    const on = rows.filter((r) => r.enabled);
    setDisabledParams(rows.filter((r) => !r.enabled));
    patch({ url: on.length ? `${base}?${buildQuery(on)}` : base });
  };

  const showCurl = async () => {
    const r = await api<string>("toCurl", { request: req, itemId: id });
    if (!r.ok) return say(r.error, true);
    const text = r.data as unknown as string;
    setDialog(
      <Modal title="Copy as cURL" onClose={() => setDialog(null)}>
        <pre className="kc-pre">{text}</pre>
        <div className="kc-row" style={{ justifyContent: "flex-end" }}>
          <button className="oce-btn" onClick={async () => say((await copy(text)) ? "Copied." : "Couldn't copy.")}>
            Copy
          </button>
          <button className="oce-btn oce-btn-primary" onClick={() => setDialog(null)}>
            Close
          </button>
        </div>
      </Modal>,
    );
  };

  const chooseEnv = async (value: string) => {
    setActiveEnv(value);
    await api("setActiveEnvironment", { id: value || null });
    const s = await api<ScopeVar[]>("scope", { itemId: id });
    if (s.ok) setScope(s.data as unknown as ScopeVar[]);
  };

  const body = req.body;
  const headerCount = req.headers.filter((h) => h.enabled && h.key).length;
  const paramCount = paramRows.filter((p) => p.enabled).length;

  return (
    <div className="rq-page">
      <div className="kc-bar rq-bar">
        <span className="kc-muted rq-path">{loaded.path.slice(0, -1).join(" / ")}</span>
        <strong>{loaded.name}</strong>
        <span className="kc-spacer" />
        <label className="kc-muted">Environment</label>
        <select className="kc-select" value={activeEnv} onChange={(e) => void chooseEnv(e.target.value)}>
          <option value="">No environment</option>
          {environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <button className="oce-btn" onClick={() => void showCurl()}>
          cURL
        </button>
        <button className="oce-btn" disabled={!dirty} onClick={() => void save()} title="Ctrl+S">
          {dirty ? "Save ●" : "Saved"}
        </button>
      </div>

      <div className="rq-urlbar">
        <select className={`kc-select rq-method ${methodClass(req.method)}`} value={req.method} onChange={(e) => patch({ method: e.target.value })}>
          {(METHODS as readonly string[]).includes(req.method) ? null : <option>{req.method}</option>}
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input
          className="kc-input rq-url"
          value={req.url}
          placeholder="https://api.example.com/items — {{variables}} are replaced when you send"
          onChange={(e) => patch({ url: e.target.value })}
          spellCheck={false}
        />
        {sending ? (
          <button className="oce-btn" onClick={() => void api("cancel", { requestId: requestId.current })}>
            Cancel
          </button>
        ) : (
          <button className="oce-btn oce-btn-primary" onClick={() => void send()} disabled={!req.url.trim()} title="Ctrl+Enter">
            Send
          </button>
        )}
      </div>
      {unknown.length > 0 && (
        <div className="rq-warn">
          No value for {unknown.map((n) => `{{${n}}}`).join(", ")} — pick an environment or define {unknown.length === 1 ? "it" : "them"} in Environments / Variables.
        </div>
      )}

      <div className="rq-main">
        <div className="rq-req">
          <div className="kc-tabs">
            {(
              [
                ["params", `Params${paramCount ? ` (${paramCount})` : ""}`],
                ["headers", `Headers${headerCount ? ` (${headerCount})` : ""}`],
                ["body", `Body${body.mode !== "none" ? " •" : ""}`],
                ["auth", `Auth${req.auth.type !== "inherit" && req.auth.type !== "none" ? " •" : ""}`],
                ["vars", "Variables"],
              ] as Array<[Tab, string]>
            ).map(([t, label]) => (
              <button key={t} className={`kc-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
                {label}
              </button>
            ))}
          </div>
          <div className="rq-pane">
            {tab === "params" && <KVTable rows={paramRows} onChange={setParams} make={newKV} keyLabel="Parameter" />}
            {tab === "headers" && <KVTable rows={req.headers} onChange={(headers) => patch({ headers })} make={newKV} keyLabel="Header" />}
            {tab === "body" && (
              <div className="rq-body">
                <div className="kc-row" style={{ marginBottom: 8 }}>
                  {(
                    [
                      ["none", "None"],
                      ["raw", "Raw"],
                      ["urlencoded", "x-www-form-urlencoded"],
                      ["formdata", "form-data"],
                    ] as const
                  ).map(([m, label]) => (
                    <label key={m} className="rq-radio">
                      <input
                        type="radio"
                        checked={body.mode === m}
                        onChange={() =>
                          patch({
                            body: m === "none" ? { mode: "none" } : m === "raw" ? { mode: "raw", raw: body.mode === "raw" ? body.raw : "", language: body.mode === "raw" ? body.language : "json" } : m === "urlencoded" ? { mode: "urlencoded", fields: body.mode === "urlencoded" ? body.fields : [] } : { mode: "formdata", fields: body.mode === "formdata" ? body.fields : [] },
                          })
                        }
                      />{" "}
                      {label}
                    </label>
                  ))}
                  {body.mode === "raw" && (
                    <select className="kc-select" value={body.language} onChange={(e) => patch({ body: { ...body, language: e.target.value as RawLanguage } })}>
                      {LANGS.map(([l, label]) => (
                        <option key={l} value={l}>
                          {label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {body.mode === "none" && <div className="kc-muted">This request has no body.</div>}
                {body.mode === "raw" && (
                  <div className="rq-editor">
                    <FeatureEditor
                      value={body.raw}
                      onChange={(raw) => patch({ body: { ...body, raw } })}
                      fileName={`body.${LANGS.find(([l]) => l === body.language)?.[2] ?? "txt"}`}
                      displayPath="Request body"
                      toolbarStart={<span className="kc-muted">Body</span>}
                    />
                  </div>
                )}
                {body.mode === "urlencoded" && <KVTable rows={body.fields} onChange={(fields) => patch({ body: { mode: "urlencoded", fields } })} make={newKV} />}
                {body.mode === "formdata" && (
                  <KVTable<FormField>
                    rows={body.fields}
                    onChange={(fields) => patch({ body: { mode: "formdata", fields } })}
                    make={() => ({ ...newKV(), type: "text" })}
                    valueLabel="Value (or file path)"
                    extra={(row, update) => (
                      <select className="kc-select" value={row.type} onChange={(e) => update({ type: e.target.value as FormField["type"] })}>
                        <option value="text">Text</option>
                        <option value="file">File</option>
                      </select>
                    )}
                  />
                )}
              </div>
            )}
            {tab === "auth" && (
              <AuthEditor
                auth={req.auth}
                onChange={(auth) => patch({ auth })}
                inheritedLabel={loaded.inheritedAuth.type === "none" ? "Nothing to inherit — the collection and folders have no auth set." : `Inherits “${loaded.inheritedAuth.type}” auth from the collection or a folder.`}
              />
            )}
            {tab === "vars" && (
              <div>
                <div className="kc-muted" style={{ marginBottom: 6 }}>
                  Variables available to this request. Environment values override collection values. Edit them under Environments / the collection settings in the workspace view.
                </div>
                {scope.length === 0 ? (
                  <div className="kc-muted">None defined.</div>
                ) : (
                  <table className="kc-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Value</th>
                        <th>From</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scope.map((v) => (
                        <tr key={v.key}>
                          <td>{`{{${v.key}}}`}</td>
                          <td>{v.secret ? "••••••" : v.value}</td>
                          <td className="kc-muted">{v.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="kc-muted" style={{ marginTop: 8 }}>
                  Built in: {"{{$guid}}"}, {"{{$timestamp}}"}, {"{{$isoTimestamp}}"}, {"{{$randomInt}}"}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="rq-res">
          {sending && <div className="kc-message kc-muted">Sending…</div>}
          {!sending && sendError && (
            <div className="kc-message">
              <div className="kc-error">{sendError}</div>
            </div>
          )}
          {!sending && !sendError && !result && <div className="kc-message kc-muted">Press Send (Ctrl+Enter) to see the response.</div>}
          {!sending && result && (
            <ResponseView
              result={result}
              tab={resTab}
              setTab={setResTab}
              pretty={pretty}
              setPretty={setPretty}
              onCopy={async (text) => say((await copy(text)) ? "Copied." : "Couldn't copy.")}
            />
          )}
        </div>
      </div>
      {dialog}
      {toast}
    </div>
  );
}

function ResponseView({ result, tab, setTab, pretty, setPretty, onCopy }: { result: SendResult; tab: ResTab; setTab: (t: ResTab) => void; pretty: boolean; setPretty: (v: boolean) => void; onCopy: (text: string) => void }) {
  const r = result.response;
  const ext = extensionFor(r.contentType);
  const shown = useMemo(() => {
    if (r.binary) return "";
    if (pretty && ext === "json" && r.body.length < 2_000_000) {
      try {
        return JSON.stringify(JSON.parse(r.body), null, 2);
      } catch {
        return r.body;
      }
    }
    return r.body;
  }, [r.body, r.binary, ext, pretty]);
  const isImage = r.binary && /^image\//i.test(r.contentType);

  return (
    <div className="rq-res-inner">
      <div className="kc-bar rq-status">
        <span className={`rq-code ${statusTone(r.status)}`}>
          {r.status} {r.statusText}
        </span>
        <span className="kc-muted">{r.ms} ms</span>
        <span className="kc-muted">{formatBytes(r.size)}</span>
        {r.redirects.length > 0 && <span className="kc-muted" title={r.redirects.join("\n")}>{r.redirects.length} redirect{r.redirects.length === 1 ? "" : "s"}</span>}
        {result.unresolved.length > 0 && <span className="warn">Unresolved: {result.unresolved.map((n) => `{{${n}}}`).join(", ")}</span>}
        <span className="kc-spacer" />
        <div className="kc-tabs rq-restabs">
          {(
            [
              ["body", "Body"],
              ["headers", `Headers (${r.headers.length})`],
              ["cookies", `Cookies${r.cookies.length ? ` (${r.cookies.length})` : ""}`],
              ["sent", "Request"],
            ] as Array<[ResTab, string]>
          ).map(([t, label]) => (
            <button key={t} className={`kc-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="rq-res-body">
        {tab === "body" &&
          (isImage ? (
            <div className="rq-image">
              <img src={`data:${r.contentType};base64,${r.body}`} alt="response" />
            </div>
          ) : r.binary ? (
            <div className="kc-message kc-muted">Binary response ({r.contentType || "unknown type"}, {formatBytes(r.size)}) — not shown.</div>
          ) : (
            <FeatureEditor
              value={shown}
              onChange={() => {}}
              readOnly
              fileName={`response.${ext}`}
              displayPath={r.url}
              toolbarStart={<span className="kc-muted">{r.contentType || "no content type"}{r.truncated ? " — truncated" : ""}</span>}
              toolbarEnd={
                <>
                  {ext === "json" && (
                    <button className="oce-btn" onClick={() => setPretty(!pretty)}>
                      {pretty ? "Raw" : "Pretty"}
                    </button>
                  )}
                  <button className="oce-btn" onClick={() => onCopy(shown)}>
                    Copy
                  </button>
                </>
              }
            />
          ))}
        {tab === "headers" && (
          <div className="rq-scroll">
            <table className="kc-table">
              <tbody>
                {r.headers.map(([k, v], i) => (
                  <tr key={i}>
                    <td className="rq-hk">{k}</td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tab === "cookies" && (
          <div className="rq-scroll">{r.cookies.length === 0 ? <div className="kc-muted">No cookies were set.</div> : r.cookies.map((c, i) => <pre key={i} className="kc-pre" style={{ marginBottom: 6 }}>{c}</pre>)}</div>
        )}
        {tab === "sent" && (
          <div className="rq-scroll">
            <pre className="kc-pre">
              {result.sent.method} {result.sent.url}
              {"\n"}
              {result.sent.headers.join("\n")}
              {result.sent.body ? `\n\n${result.sent.body}` : ""}
            </pre>
            <div className="kc-muted" style={{ marginTop: 6 }}>Credentials are masked here and in the Output panel.</div>
          </div>
        )}
      </div>
    </div>
  );
}

