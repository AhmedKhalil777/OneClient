import { useCallback, useEffect, useMemo, useState } from "react";
import { FeatureEditor } from "@oneclient/editor-kit/editor";
import { ConfirmDialog, FormDialog, api, copy, qs, useToast } from "./kit.js";

interface Detail {
  key: string;
  type: string;
  ttl: number;
  memory?: number;
  encoding?: string;
  length: number;
  value: unknown;
  truncated: boolean;
}

const db = Number(qs.get("db") ?? 0);
const initialKey = qs.get("key") ?? "";

export const TYPE_LABEL: Record<string, string> = { string: "STRING", hash: "HASH", list: "LIST", set: "SET", zset: "SORTED SET", stream: "STREAM", "ReJSON-RL": "JSON" };

export function formatTtl(ms: number): string {
  if (ms === -1) return "No expiry";
  if (ms === -2) return "Expired";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export const formatBytes = (n?: number) => (n === undefined ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const looksJson = (s: string) => /^\s*[[{]/.test(s) && (() => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
})();

/** An editable list of rows (hash fields, list items, set members, sorted-set members). */
function RowsEditor({
  columns,
  rows,
  onSave,
  onDelete,
  addLabel,
  newRow,
  filterable = true,
}: {
  columns: string[];
  rows: string[][];
  onSave: (row: string[], original: string[] | null, index: number) => Promise<string | void>;
  onDelete?: (row: string[], index: number) => Promise<string | void>;
  addLabel?: string;
  newRow?: string[];
  filterable?: boolean;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const shown = rows.map((r, i) => ({ r, i })).filter(({ r }) => !filter || r.some((c) => c.toLowerCase().includes(filter.toLowerCase())));

  const commit = async () => {
    const original = editing !== null && editing >= 0 ? rows[editing]! : null;
    const err = await onSave(draft, original, editing ?? -1);
    if (err) return setError(err);
    setError("");
    setEditing(null);
  };

  return (
    <div className="rk-rows">
      <div className="kc-row" style={{ marginBottom: 6 }}>
        {filterable && <input className="kc-input" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        {addLabel && newRow && (
          <button
            className="oce-btn"
            onClick={() => {
              setEditing(-1);
              setDraft(newRow);
              setError("");
            }}
          >
            + {addLabel}
          </button>
        )}
        {error && <span className="kc-error">{error}</span>}
      </div>
      <table className="kc-table rk-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
            <th style={{ width: 120 }} />
          </tr>
        </thead>
        <tbody>
          {editing === -1 && (
            <tr className="rk-editing">
              {draft.map((v, ci) => (
                <td key={ci}>
                  <textarea className="kc-input rk-cell" rows={1} value={v} autoFocus={ci === 0} onChange={(e) => setDraft(draft.map((x, j) => (j === ci ? e.target.value : x)))} />
                </td>
              ))}
              <td>
                <div className="kc-actions">
                  <button className="oce-btn oce-btn-primary" onClick={() => void commit()}>
                    Add
                  </button>
                  <button className="oce-btn" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </td>
            </tr>
          )}
          {shown.map(({ r, i }) =>
            editing === i ? (
              <tr key={i} className="rk-editing">
                {draft.map((v, ci) => (
                  <td key={ci}>
                    <textarea className="kc-input rk-cell" rows={Math.min(8, Math.max(1, v.split("\n").length))} value={v} onChange={(e) => setDraft(draft.map((x, j) => (j === ci ? e.target.value : x)))} />
                  </td>
                ))}
                <td>
                  <div className="kc-actions">
                    <button className="oce-btn oce-btn-primary" onClick={() => void commit()}>
                      Save
                    </button>
                    <button className="oce-btn" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={i}>
                {r.map((v, ci) => (
                  <td key={ci} className="rk-value" title={v}>
                    {v}
                  </td>
                ))}
                <td>
                  <div className="kc-actions rk-rowactions">
                    <button
                      className="oce-btn"
                      onClick={() => {
                        setEditing(i);
                        setDraft([...r]);
                        setError("");
                      }}
                    >
                      Edit
                    </button>
                    {onDelete && (
                      <button
                        className="oce-btn"
                        onClick={async () => {
                          const err = await onDelete(r, i);
                          if (err) setError(err);
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** One key: type, TTL, size and an editor for its value (per type). */
export function KeyView() {
  const [key, setKey] = useState(initialKey);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [dialog, setDialog] = useState<React.ReactNode>(null);
  const [toast, say] = useToast();
  const [now, setNow] = useState(Date.now());
  const [loadedAt, setLoadedAt] = useState(Date.now());

  const load = useCallback(async () => {
    const r = await api<Detail>("key", { db, key });
    if (!r.ok) return setError(r.error);
    setError("");
    setDetail(r.data as unknown as Detail);
    setLoadedAt(Date.now());
    if (r.data.type === "string" || r.data.type === "ReJSON-RL") {
      const v = String(r.data.value ?? "");
      const pretty = looksJson(v) && v.length < 500_000 ? JSON.stringify(JSON.parse(v), null, 2) : v;
      setText(pretty);
      setSavedText(pretty);
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const dirty = text !== savedText;
  useEffect(() => window.oneclientView.setDirty(dirty), [dirty]);

  const edit = async (op: string, params: Record<string, unknown>): Promise<string | void> => {
    const r = await api("edit", { db, key, op, ...params });
    if (!r.ok) return r.error;
    await load();
  };

  const isJson = useMemo(() => detail?.type === "ReJSON-RL" || looksJson(savedText), [detail, savedText]);

  if (error) {
    return (
      <div className="kc-message">
        <div className="kc-error">{error}</div>
        <button className="oce-btn" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (!detail) return <div className="kc-message">Loading…</div>;

  const ttlLeft = detail.ttl > 0 ? Math.max(0, detail.ttl - (now - loadedAt)) : detail.ttl;

  const saveString = async () => {
    // Keep the author's formatting choice: save what's in the editor as is (minified JSON stays a choice of the editor's Minify action).
    const err = await edit(detail.type === "ReJSON-RL" ? "jsonset" : "set", { value: text });
    if (err) return say(err, true);
    setSavedText(text);
    say("Saved.");
  };

  const setTtlDialog = () =>
    setDialog(
      <FormDialog
        title="Expiry (TTL)"
        submitLabel="Set"
        fields={[{ key: "seconds", label: "Expire after (seconds)", required: true, value: detail.ttl > 0 ? String(Math.round(ttlLeft / 1000)) : "3600" }]}
        onClose={() => setDialog(null)}
        onSubmit={async (v) => {
          const r = await api("ttl", { db, key, seconds: Number(v.seconds) });
          if (!r.ok) return r.error;
          await load();
        }}
      />,
    );

  const renameDialog = () =>
    setDialog(
      <FormDialog
        title="Rename key"
        submitLabel="Rename"
        fields={[{ key: "to", label: "New name", required: true, value: key }]}
        onClose={() => setDialog(null)}
        onSubmit={async (v) => {
          const r = await api("rename", { db, key, to: String(v.to) });
          if (!r.ok) return r.error;
          setKey(String(v.to));
          window.oneclientView.refreshExplorer();
          say("Renamed.");
        }}
      />,
    );

  const deleteDialog = () =>
    setDialog(
      <ConfirmDialog
        title="Delete key"
        text={`Delete "${key}"?`}
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          const r = await api("delete", { db, key });
          if (!r.ok) return say(r.error, true);
          window.oneclientView.setDirty(false);
          window.oneclientView.refreshExplorer();
          setError(`"${key}" was deleted.`);
        }}
      />,
    );

  const v = detail.value;
  return (
    <div className="kc-page">
      <div className="kc-bar rk-head">
        <span className={`rk-type rk-${detail.type.replace(/[^a-z]/gi, "")}`}>{TYPE_LABEL[detail.type] ?? detail.type.toUpperCase()}</span>
        <span className="rk-key" title={key}>
          {key}
        </span>
        <button className="kc-link" onClick={async () => say((await copy(key)) ? "Key name copied." : "Couldn't copy.")} title="Copy the key name">
          copy
        </button>
        <span className="kc-spacer" />
        <span className="kc-muted" title="Database">db{db}</span>
        <span className="kc-muted">{detail.type === "string" ? `${detail.length.toLocaleString()} chars` : `${detail.length.toLocaleString()} items`}</span>
        {detail.memory !== undefined && <span className="kc-muted">{formatBytes(detail.memory)}</span>}
        {detail.encoding && <span className="kc-muted">{detail.encoding}</span>}
        <span className={`rk-ttl ${detail.ttl > 0 ? "on" : ""}`}>⏱ {formatTtl(ttlLeft)}</span>
        <button className="oce-btn" onClick={setTtlDialog}>
          TTL…
        </button>
        {detail.ttl > 0 && (
          <button
            className="oce-btn"
            onClick={async () => {
              const r = await api("ttl", { db, key, seconds: null });
              if (!r.ok) return say(r.error, true);
              await load();
            }}
          >
            Persist
          </button>
        )}
        <button className="oce-btn" onClick={renameDialog}>
          Rename…
        </button>
        <button className="oce-btn" onClick={() => void load()} title="Reload from Redis">
          Refresh
        </button>
        <button className="oce-btn" onClick={deleteDialog}>
          Delete
        </button>
      </div>
      {detail.truncated && <div className="rk-warn">Showing only the first part of this key ({detail.length.toLocaleString()} {detail.type === "string" ? "characters" : "items"} in total).</div>}

      <div className="rk-body">
        {(detail.type === "string" || detail.type === "ReJSON-RL") && (
          <div className="rk-editor">
            <FeatureEditor
              value={text}
              onChange={setText}
              fileName={isJson ? "value.json" : "value.txt"}
              displayPath={key}
              readOnly={detail.truncated}
              onSave={() => void saveString()}
              toolbarStart={<span className="kc-muted">{isJson ? "JSON" : "Text"}</span>}
              toolbarEnd={
                <>
                  <button className="oce-btn" disabled={!dirty} onClick={() => setText(savedText)}>
                    Revert
                  </button>
                  <button className="oce-btn oce-btn-primary" disabled={!dirty || detail.truncated} onClick={() => void saveString()} title="Save (Ctrl+S)">
                    Save
                  </button>
                </>
              }
            />
          </div>
        )}
        {detail.type === "hash" && (
          <RowsEditor
            columns={["Field", "Value"]}
            rows={(v as Array<[string, string]>).map(([f, x]) => [f, x])}
            addLabel="Field"
            newRow={["", ""]}
            onSave={(row, original) => edit("hset", { field: row[0], value: row[1], ...(original ? { oldField: original[0] } : {}) })}
            onDelete={(row) => edit("hdel", { field: row[0] })}
          />
        )}
        {detail.type === "list" && (
          <>
            <RowsEditor
              columns={["Index", "Value"]}
              rows={(v as string[]).map((x, i) => [String(i), x])}
              addLabel="Push to tail"
              newRow={["(tail)", ""]}
              onSave={(row, original) => (original ? edit("lset", { index: Number(original[0]), value: row[1] }) : edit("rpush", { value: row[1] }))}
              onDelete={(row) => edit("lremIndex", { index: Number(row[0]) })}
            />
            <div className="kc-muted rk-hint">The index column can't be edited; “Push to tail” adds at the end (RPUSH).</div>
          </>
        )}
        {detail.type === "set" && (
          <RowsEditor
            columns={["Member"]}
            rows={(v as string[]).map((x) => [x])}
            addLabel="Member"
            newRow={[""]}
            onSave={(row, original) => (original ? edit("sreplace", { oldMember: original[0], member: row[0] }) : edit("sadd", { member: row[0] }))}
            onDelete={(row) => edit("srem", { member: row[0] })}
          />
        )}
        {detail.type === "zset" && (
          <RowsEditor
            columns={["Member", "Score"]}
            rows={(v as Array<[string, number]>).map(([m, s]) => [m, String(s)])}
            addLabel="Member"
            newRow={["", "0"]}
            onSave={(row, original) => {
              if (!Number.isFinite(Number(row[1]))) return Promise.resolve("The score must be a number.");
              return edit("zadd", { member: row[0], score: Number(row[1]), ...(original ? { oldMember: original[0] } : {}) });
            }}
            onDelete={(row) => edit("zrem", { member: row[0] })}
          />
        )}
        {detail.type === "stream" && (
          <StreamView
            entries={v as Array<{ id: string; fields: Record<string, string> }>}
            onAdd={(fields) => edit("xadd", { fields })}
            onDelete={(id) => edit("xdel", { id })}
          />
        )}
      </div>
      {dialog}
      {toast}
    </div>
  );
}

function StreamView({ entries, onAdd, onDelete }: { entries: Array<{ id: string; fields: Record<string, string> }>; onAdd: (fields: Record<string, string>) => Promise<string | void>; onDelete: (id: string) => Promise<string | void> }) {
  const [draft, setDraft] = useState("field=value");
  const [error, setError] = useState("");
  const fieldNames = [...new Set(entries.flatMap((e) => Object.keys(e.fields)))];
  return (
    <div>
      <div className="kc-row" style={{ marginBottom: 8 }}>
        <input className="kc-input" style={{ minWidth: 320 }} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="field=value, other=value" />
        <button
          className="oce-btn oce-btn-primary"
          onClick={async () => {
            const fields = Object.fromEntries(
              draft
                .split(/,|\n/)
                .map((p) => p.trim())
                .filter(Boolean)
                .map((p) => {
                  const i = p.indexOf("=");
                  return i < 0 ? [p, ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
                }),
            );
            const err = await onAdd(fields);
            setError(err ?? "");
          }}
        >
          Add entry (XADD *)
        </button>
        {error && <span className="kc-error">{error}</span>}
      </div>
      <table className="kc-table rk-table">
        <thead>
          <tr>
            <th>ID</th>
            {fieldNames.map((f) => (
              <th key={f}>{f}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="rk-mono" title={new Date(Number(e.id.split("-")[0])).toLocaleString()}>
                {e.id}
              </td>
              {fieldNames.map((f) => (
                <td key={f} className="rk-value">
                  {e.fields[f] ?? ""}
                </td>
              ))}
              <td>
                <button className="oce-btn" onClick={async () => setError((await onDelete(e.id)) ?? "")}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="kc-muted rk-hint">Newest first; the 200 latest entries are shown.</div>
    </div>
  );
}
