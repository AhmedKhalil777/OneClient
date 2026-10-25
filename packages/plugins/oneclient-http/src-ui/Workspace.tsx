import { useCallback, useEffect, useRef, useState } from "react";
import { FeatureEditor } from "@oneclient/editor-kit/editor";
import type { AuthDef, Environment, KV, RequestDef } from "../src/model.js";
import { ConfirmDialog, FormDialog, api, copy, fmtTime, open, qs, useToast } from "./kit.js";
import { AuthEditor, KVTable, methodClass, newKV, statusTone } from "./parts.js";

type Tab = "collections" | "environments" | "history" | "import";

interface Overview {
  collections: Array<{ id: string; name: string; description: string; requests: number }>;
  environments: Array<{ id: string; name: string; variables: number }>;
  activeEnvironmentId: string | null;
  historyCount: number;
  file: string;
}

const TAB_LABEL: Record<Tab, string> = { collections: "Collections", environments: "Environments", history: "History", import: "Import / Export" };

/** The workspace dashboard: collections, environments, history, and Postman / cURL import & export. */
export function Workspace() {
  const initial = (qs.get("tab") === "export" ? "import" : qs.get("tab")) as Tab | null;
  const [tab, setTab] = useState<Tab>(initial && initial in TAB_LABEL ? initial : "collections");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<React.ReactNode>(null);
  const [toast, say] = useToast();

  const reload = useCallback(async () => {
    const r = await api<Overview>("overview");
    if (!r.ok) return setError(r.error);
    setError("");
    setOverview(r.data);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) return <div className="kc-message kc-error">{error}</div>;
  if (!overview) return <div className="kc-message">Loading…</div>;

  const ctx = { overview, reload, say, setDialog };
  return (
    <div className="kc-page">
      <div className="kc-bar">
        <span className="kc-title">HTTP Workspace</span>
        <span className="kc-muted" title={overview.file}>
          {overview.collections.length} collection{overview.collections.length === 1 ? "" : "s"} · {overview.environments.length} environment{overview.environments.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="kc-tabs">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button key={t} className={`kc-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="kc-body">
        {tab === "collections" && <Collections {...ctx} />}
        {tab === "environments" && <Environments {...ctx} />}
        {tab === "history" && <History {...ctx} />}
        {tab === "import" && <ImportExport {...ctx} presetId={qs.get("id") ?? ""} />}
      </div>
      {dialog}
      {toast}
    </div>
  );
}

interface Ctx {
  overview: Overview;
  reload: () => Promise<void>;
  say: (t: string, err?: boolean) => void;
  setDialog: (d: React.ReactNode) => void;
}

// ---- collections -------------------------------------------------------------------------------------------------

function Collections({ overview, reload, say, setDialog }: Ctx) {
  const [editing, setEditing] = useState<string | null>(null);

  const create = () =>
    setDialog(
      <FormDialog
        title="New collection"
        submitLabel="Create"
        fields={[{ key: "name", label: "Name", required: true }]}
        onClose={() => setDialog(null)}
        onSubmit={async (v) => {
          const r = await api("create", { kind: "collection", name: String(v.name) });
          if (!r.ok) return r.error;
          await reload();
        }}
      />,
    );

  return (
    <>
      <div className="kc-row" style={{ marginBottom: 10 }}>
        <button className="oce-btn oce-btn-primary" onClick={create}>
          New collection
        </button>
        <span className="kc-muted">Add requests from the explorer (right-click a collection), or import them in the Import / Export tab.</span>
      </div>
      {overview.collections.length === 0 ? (
        <div className="kc-muted">No collections yet.</div>
      ) : (
        overview.collections.map((c) => (
          <div className="kc-box" style={{ marginBottom: 10 }} key={c.id}>
            <h4>
              <span>
                <strong>{c.name}</strong> <span className="kc-muted">— {c.requests} request{c.requests === 1 ? "" : "s"}</span>
              </span>
              <span className="kc-row">
                <button className="kc-link" onClick={() => setEditing(editing === c.id ? null : c.id)}>
                  {editing === c.id ? "Close settings" : "Settings"}
                </button>
                <button className="kc-link" onClick={() => open("http.workspace", "Export collection", { tab: "export", id: c.id }, "$(file-code)")}>
                  Export
                </button>
                <button
                  className="kc-link"
                  onClick={async () => {
                    const r = await api("duplicate", { id: c.id });
                    say(r.ok ? "Duplicated." : r.error, !r.ok);
                    void reload();
                  }}
                >
                  Duplicate
                </button>
                <button
                  className="kc-link"
                  onClick={() =>
                    setDialog(
                      <ConfirmDialog
                        title="Delete collection"
                        text={`Delete "${c.name}" and its ${c.requests} request${c.requests === 1 ? "" : "s"}? This cannot be undone.`}
                        onClose={() => setDialog(null)}
                        onConfirm={async () => {
                          const r = await api("remove", { id: c.id });
                          if (!r.ok) say(r.error, true);
                          void reload();
                        }}
                      />,
                    )
                  }
                >
                  Delete
                </button>
              </span>
            </h4>
            {editing === c.id && <CollectionSettings id={c.id} say={say} onSaved={() => void reload()} />}
          </div>
        ))
      )}
    </>
  );
}

function CollectionSettings({ id, say, onSaved }: { id: string; say: Ctx["say"]; onSaved: () => void }) {
  const [c, setC] = useState<{ name: string; description: string; auth: AuthDef; variables: KV[] } | null>(null);
  useEffect(() => {
    void api<{ name: string; description: string; auth: AuthDef; variables: KV[] }>("getCollection", { id }).then((r) => (r.ok ? setC(r.data) : say(r.error, true)));
  }, [id, say]);
  if (!c) return <div className="kc-muted" style={{ padding: 10 }}>Loading…</div>;
  return (
    <div style={{ padding: 10 }}>
      <div className="kc-split">
        <div className="kc-field">
          <label>Name</label>
          <input className="kc-input" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
        </div>
        <div className="kc-field">
          <label>Description</label>
          <input className="kc-input" value={c.description} onChange={(e) => setC({ ...c, description: e.target.value })} />
        </div>
      </div>
      <h2 className="kc-h">Authorization (used by requests set to “Inherit”)</h2>
      <AuthEditor auth={c.auth} allowInherit={false} onChange={(auth) => setC({ ...c, auth })} />
      <h2 className="kc-h">Collection variables</h2>
      <KVTable rows={c.variables} onChange={(variables) => setC({ ...c, variables })} make={newKV} keyLabel="Variable" />
      <div className="kc-row" style={{ marginTop: 10 }}>
        <button
          className="oce-btn oce-btn-primary"
          onClick={async () => {
            const r = await api("saveCollection", { id, ...c, variables: c.variables.filter((v) => v.key.trim()) });
            say(r.ok ? "Saved." : r.error, !r.ok);
            if (r.ok) onSaved();
          }}
        >
          Save settings
        </button>
      </div>
    </div>
  );
}

// ---- environments ------------------------------------------------------------------------------------------------

type Env = Environment;

function Environments({ overview, reload, say, setDialog }: Ctx) {
  const [envs, setEnvs] = useState<Env[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [draft, setDraft] = useState<Env | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ environments: Env[] }>("getEnvironments");
    if (r.ok) setEnvs(r.data.environments);
  }, []);
  useEffect(() => {
    void load();
  }, [load, overview.environments.length]);

  useEffect(() => {
    const e = envs.find((x) => x.id === selected) ?? envs[0];
    if (e && (!draft || draft.id !== e.id) && !dirty) {
      setSelected(e.id);
      setDraft(JSON.parse(JSON.stringify(e)) as Env);
    }
    if (!e) setDraft(null);
  }, [envs, selected, draft, dirty]);

  const newEnv = () =>
    setDialog(
      <FormDialog
        title="New environment"
        submitLabel="Create"
        fields={[{ key: "name", label: "Name", required: true, placeholder: "Development" }]}
        onClose={() => setDialog(null)}
        onSubmit={async (v) => {
          const r = await api<{ id: string }>("saveEnvironment", { environment: { name: String(v.name), variables: [] } });
          if (!r.ok) return r.error;
          setDirty(false);
          setSelected(r.data.id);
          setDraft(null);
          await load();
          await reload();
        }}
      />,
    );

  const save = async () => {
    if (!draft) return;
    const r = await api("saveEnvironment", { environment: { ...draft, variables: draft.variables.filter((v) => v.key.trim()) } });
    if (!r.ok) return say(r.error, true);
    say("Saved.");
    setDirty(false);
    await load();
    await reload();
  };

  const isActive = overview.activeEnvironmentId === draft?.id;

  return (
    <div className="env-layout">
      <div className="env-list kc-box">
        <h4>
          <span>Environments</span>
          <button className="kc-link" onClick={newEnv}>
            + New
          </button>
        </h4>
        <div className="kc-list" style={{ maxHeight: "none" }}>
          {envs.length === 0 && <div className="kc-muted" style={{ padding: "6px 10px" }}>None yet — an environment holds variables such as {"{{baseUrl}}"} and {"{{token}}"}.</div>}
          {envs.map((e) => (
            <div
              key={e.id}
              className={`kc-item${e.id === selected ? " env-sel" : ""}`}
              onClick={() => {
                if (dirty && !confirm("Discard unsaved changes to this environment?")) return;
                setDirty(false);
                setSelected(e.id);
                setDraft(JSON.parse(JSON.stringify(e)) as Env);
              }}
            >
              <span>{e.name}</span>
              {overview.activeEnvironmentId === e.id && <span className="kc-badge">active</span>}
            </div>
          ))}
        </div>
      </div>
      <div>
        {draft && (
          <>
            <div className="kc-row" style={{ marginBottom: 10 }}>
              <input className="kc-input" value={draft.name} onChange={(e) => (setDraft({ ...draft, name: e.target.value }), setDirty(true))} style={{ minWidth: 220 }} />
              <button className="oce-btn oce-btn-primary" disabled={!dirty} onClick={() => void save()}>
                Save
              </button>
              <button
                className="oce-btn"
                onClick={async () => {
                  await api("setActiveEnvironment", { id: isActive ? null : draft.id });
                  await reload();
                }}
              >
                {isActive ? "Deactivate" : "Make active"}
              </button>
              <button className="oce-btn" onClick={() => open("http.workspace", "Export environment", { tab: "export", env: draft.id }, "$(file-code)")}>
                Export
              </button>
              <button
                className="oce-btn"
                onClick={() =>
                  setDialog(
                    <ConfirmDialog
                      title="Delete environment"
                      text={`Delete "${draft.name}"?`}
                      onClose={() => setDialog(null)}
                      onConfirm={async () => {
                        await api("deleteEnvironment", { id: draft.id });
                        setDirty(false);
                        setDraft(null);
                        setSelected("");
                        await load();
                        await reload();
                      }}
                    />,
                  )
                }
              >
                Delete
              </button>
            </div>
            <KVTable<KV & { secret?: boolean }>
              rows={draft.variables}
              onChange={(variables) => (setDraft({ ...draft, variables }), setDirty(true))}
              make={newKV}
              keyLabel="Variable"
              valueLabel="Value"
              extra={(row, update) => (
                <label className="kc-muted" title="Masked in the Variables tab and never logged">
                  <input type="checkbox" checked={row.secret === true} onChange={(e) => update({ secret: e.target.checked })} /> secret
                </label>
              )}
            />
            <div className="kc-muted" style={{ marginTop: 8 }}>
              Use a variable as {"{{name}}"} in URLs, headers, bodies and auth. Pick the active environment in any request.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---- history -----------------------------------------------------------------------------------------------------

interface HistoryRow {
  id: string;
  time: number;
  method: string;
  url: string;
  status?: number;
  ms?: number;
  error?: string;
}

function History({ overview, reload, say, setDialog }: Ctx) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const load = useCallback(async () => {
    const r = await api<HistoryRow[]>("history");
    if (r.ok) setRows(r.data as unknown as HistoryRow[]);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const saveAs = (row: HistoryRow) =>
    setDialog(
      <FormDialog
        title="Save as request"
        submitLabel="Save and open"
        fields={[
          { key: "name", label: "Request name", required: true, value: `${row.method} ${safePath(row.url)}` },
          { key: "collection", label: overview.collections.length ? "Collection (name — existing or new)" : "New collection name", required: true, value: overview.collections[0]?.name ?? "My requests" },
        ]}
        onClose={() => setDialog(null)}
        onSubmit={async (v) => {
          const entry = await api<{ request: RequestDef }>("historyEntry", { id: row.id });
          if (!entry.ok) return entry.error;
          let target = overview.collections.find((c) => c.name === v.collection)?.id;
          if (!target) {
            const c = await api<{ id: string }>("create", { kind: "collection", name: String(v.collection) });
            if (!c.ok) return c.error;
            target = c.data.id;
          }
          const created = await api<{ id: string }>("create", { kind: "request", parentId: target, name: String(v.name), request: entry.data.request });
          if (!created.ok) return created.error;
          await reload();
          open("http.request", String(v.name), { id: created.data.id }, "$(play)");
        }}
      />,
    );

  return (
    <>
      <div className="kc-row" style={{ marginBottom: 10 }}>
        <button
          className="oce-btn"
          disabled={!rows?.length}
          onClick={async () => {
            await api("clearHistory");
            await load();
            await reload();
            say("History cleared.");
          }}
        >
          Clear history
        </button>
        <span className="kc-muted">The last 200 requests you sent.</span>
      </div>
      {!rows ? (
        <div className="kc-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="kc-muted">Nothing sent yet.</div>
      ) : (
        <table className="kc-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Method</th>
              <th>URL</th>
              <th>Status</th>
              <th>Time</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.id}>
                <td className="kc-muted">{fmtTime(new Date(h.time).toISOString())}</td>
                <td>
                  <span className={methodClass(h.method)}>{h.method}</span>
                </td>
                <td style={{ wordBreak: "break-all" }}>{h.url}</td>
                <td className={h.status ? statusTone(h.status) : "kc-error"}>{h.status ?? "failed"}</td>
                <td className="kc-muted">{h.ms !== undefined ? `${h.ms} ms` : ""}</td>
                <td>
                  <button className="oce-btn" onClick={() => saveAs(h)}>
                    Save as request…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.host : u.pathname;
  } catch {
    return url.slice(0, 60);
  }
}

// ---- import / export ---------------------------------------------------------------------------------------------

interface ImportResult {
  kind: string;
  name: string;
  items: Array<{ kind: string; name: string }>;
  report?: { requests: number; folders: number; scripts: number; warnings: string[] };
  notes?: string[];
}

function ImportExport({ overview, reload, say, presetId }: Ctx & { presetId: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Array<{ source: string; result?: ImportResult; error?: string }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const doImport = async (source: string, payload: string) => {
    const r = await api<ImportResult>("importText", { text: payload });
    setResults((prev) => [{ source, ...(r.ok ? { result: r.data as unknown as ImportResult } : { error: r.error }) }, ...prev]);
    await reload();
    return r.ok;
  };

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    setBusy(true);
    for (const f of Array.from(files)) await doImport(f.name, await f.text());
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div>
      <h2 className="kc-h" style={{ marginTop: 0 }}>Import</h2>
      <div className="kc-muted" style={{ marginBottom: 8 }}>
        Postman <strong>collections</strong> (v2.0 / v2.1), Postman <strong>environments</strong> and “Export Data” dumps, or a request copied from the browser — in dev tools open <em>Network</em>, right-click a request and choose <strong>Copy as cURL</strong> (bash or cmd), <strong>Copy as PowerShell</strong> or <strong>Copy as fetch</strong>, then paste it below.
      </div>
      <div className="kc-row" style={{ marginBottom: 8 }}>
        <input ref={fileRef} type="file" accept=".json,application/json,.txt" multiple onChange={(e) => void onFiles(e.target.files)} disabled={busy} />
      </div>
      <textarea className="kc-textarea" rows={6} placeholder={"Paste a cURL / PowerShell / fetch command or Postman JSON here"} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="kc-row" style={{ margin: "8px 0 14px" }}>
        <button
          className="oce-btn"
          disabled={busy}
          title="Paste what you copied (needs permission to read the clipboard)"
          onClick={() => void navigator.clipboard?.readText().then((t) => t && setText(t)).catch(() => say("The browser did not allow reading the clipboard — paste into the box with Ctrl+V.", true))}
        >
          Paste from clipboard
        </button>
        <button
          className="oce-btn oce-btn-primary"
          disabled={!text.trim() || busy}
          onClick={async () => {
            setBusy(true);
            const ok = await doImport("pasted text", text);
            setBusy(false);
            if (ok) setText("");
          }}
        >
          Import
        </button>
      </div>
      {results.map((r, i) => (
        <div key={i} className="kc-box" style={{ marginBottom: 8, padding: 10 }}>
          <div>
            <strong>{r.source}</strong>{" "}
            {r.error ? <span className="kc-error">— {r.error}</span> : <span className="kc-ok">— imported {r.result?.items.map((x) => `${x.kind} “${x.name}”`).join(", ")}</span>}
          </div>
          {r.result?.report && (
            <div className="kc-muted">
              {r.result.report.requests} request{r.result.report.requests === 1 ? "" : "s"}, {r.result.report.folders} folder{r.result.report.folders === 1 ? "" : "s"}
              {r.result.report.scripts > 0 && ` — ${r.result.report.scripts} Postman script${r.result.report.scripts === 1 ? "" : "s"} skipped (oneClient doesn't run scripts)`}
            </div>
          )}
          {r.result?.report?.warnings.map((w, j) => (
            <div key={j} className="warn">
              {w}
            </div>
          ))}
          {r.result?.notes?.map((n, j) => (
            <div key={j} className="kc-muted">
              {n}
            </div>
          ))}
        </div>
      ))}

      <h2 className="kc-h">Export as Postman</h2>
      <ExportPanel overview={overview} say={say} presetCollection={presetId} presetEnv={qs.get("env") ?? ""} />
    </div>
  );
}

function ExportPanel({ overview, say, presetCollection, presetEnv }: { overview: Overview; say: Ctx["say"]; presetCollection: string; presetEnv: string }) {
  const [pick, setPick] = useState(presetEnv ? `env:${presetEnv}` : presetCollection ? `col:${presetCollection}` : "");
  const [doc, setDoc] = useState<{ fileName: string; json: string } | null>(null);

  useEffect(() => {
    setDoc(null);
    if (!pick) return;
    const [kind, id] = pick.split(":") as ["col" | "env", string];
    void api<{ fileName: string; json: string }>(kind === "col" ? "exportCollection" : "exportEnvironment", { id }).then((r) => (r.ok ? setDoc(r.data as unknown as { fileName: string; json: string }) : say(r.error, true)));
  }, [pick, say]);

  return (
    <div>
      <div className="kc-row" style={{ marginBottom: 8 }}>
        <select className="kc-select" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Choose what to export…</option>
          {overview.collections.map((c) => (
            <option key={c.id} value={`col:${c.id}`}>
              Collection — {c.name}
            </option>
          ))}
          {overview.environments.map((e) => (
            <option key={e.id} value={`env:${e.id}`}>
              Environment — {e.name}
            </option>
          ))}
        </select>
        {doc && <span className="kc-muted">{doc.fileName} — copy it, or paste it into a file (Postman: Import → Raw text).</span>}
      </div>
      {doc && (
        <div style={{ height: 360 }} className="rq-editor">
          <FeatureEditor
            value={doc.json}
            onChange={() => {}}
            readOnly
            fileName={doc.fileName}
            toolbarStart={<span className="kc-muted">{doc.fileName}</span>}
            toolbarEnd={
              <button className="oce-btn oce-btn-primary" onClick={async () => say((await copy(doc.json)) ? "Copied to the clipboard." : "Couldn't copy.")}>
                Copy
              </button>
            }
          />
        </div>
      )}
    </div>
  );
}

