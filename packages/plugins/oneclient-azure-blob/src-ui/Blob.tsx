import { useCallback, useEffect, useState } from "react";
import { FeatureEditor } from "@oneclient/editor-kit/editor";
import { ConfirmDialog, FormDialog, Modal, api, copy, qs, useToast } from "./kit.js";

interface Detail {
  container: string;
  name: string;
  url: string;
  size: number;
  contentType: string;
  cacheControl?: string;
  contentMd5?: string;
  etag?: string;
  lastModified?: string;
  createdOn?: string;
  blobType?: string;
  tier?: string;
  leaseState?: string;
  metadata: Record<string, string>;
  text?: string;
  base64?: string;
  truncated: boolean;
}

const container = qs.get("container") ?? "";
const initialName = qs.get("name") ?? "";

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

/** Dialog: a time-limited SAS link for a blob or a container. */
export function SasDialog({ blob, onClose, say }: { blob?: string; onClose: () => void; say: (t: string, e?: boolean) => void }) {
  const [perm, setPerm] = useState(blob ? "r" : "rl");
  const [hours, setHours] = useState(24);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const make = async () => {
    const r = await api<{ url: string }>("sas", { container, ...(blob ? { name: blob } : {}), permissions: perm, hours });
    if (!r.ok) return setError(r.error);
    setError("");
    setUrl(r.data.url);
  };
  const flags = blob ? [["r", "Read"], ["w", "Write"], ["d", "Delete"]] : [["r", "Read"], ["l", "List"], ["w", "Write"], ["d", "Delete"]];
  return (
    <Modal title={blob ? "Share blob (SAS link)" : "Share container (SAS link)"} onClose={onClose}>
      <div className="kc-row">
        {flags.map(([f, label]) => (
          <label key={f} className="kc-row" style={{ gap: 4 }}>
            <input type="checkbox" checked={perm.includes(f!)} onChange={(e) => setPerm(e.target.checked ? perm + f : perm.replace(f!, ""))} /> {label}
          </label>
        ))}
        <label className="kc-row" style={{ gap: 4 }}>
          valid for <input className="kc-input" type="number" min={1} style={{ width: 70 }} value={hours} onChange={(e) => setHours(Math.max(1, Number(e.target.value) || 1))} /> hours
        </label>
      </div>
      {url && <pre className="kc-pre ab-url">{url}</pre>}
      {error && <div className="kc-error">{error}</div>}
      <div className="kc-row" style={{ justifyContent: "flex-end" }}>
        {url && (
          <button className="oce-btn" onClick={async () => say((await copy(url)) ? "Link copied." : "Couldn't copy.")}>
            Copy
          </button>
        )}
        <button className="oce-btn oce-btn-primary" disabled={!perm} onClick={() => void make()}>
          {url ? "Regenerate" : "Create link"}
        </button>
        <button className="oce-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

const isTextName = (name: string) => /\.(json|jsonc|xml|md|markdown|csv|tsv|txt|log|yml|yaml|ini|conf|toml|html?|css|js|ts|sql|sh|ps1|py|cs|svg)$/i.test(name);

/** One blob: preview / edit, properties and metadata, and the actions on it. */
export function BlobView() {
  const [name, setName] = useState(initialName);
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"content" | "properties" | "metadata">("content");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [meta, setMeta] = useState<Array<[string, string]>>([]);
  const [headers, setHeaders] = useState({ contentType: "", cacheControl: "" });
  const [dialog, setDialog] = useState<React.ReactNode>(null);
  const [toast, say] = useToast();

  const load = useCallback(async () => {
    const r = await api<Detail>("blob", { container, name });
    if (!r.ok) return setError(r.error);
    setError("");
    const det = r.data as unknown as Detail;
    setD(det);
    setText(det.text ?? "");
    setSaved(det.text ?? "");
    setMeta(Object.entries(det.metadata));
    setHeaders({ contentType: det.contentType, cacheControl: det.cacheControl ?? "" });
  }, [name]);
  useEffect(() => {
    void load();
  }, [load]);

  const dirty = d?.text !== undefined && text !== saved;
  useEffect(() => window.oneclientView.setDirty(dirty), [dirty]);

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
  if (!d) return <div className="kc-message">Loading…</div>;

  const saveText = async () => {
    const r = await api("save", { container, name, text, etag: d.etag });
    if (!r.ok) return say(r.error, true);
    say("Saved.");
    await load();
  };

  const move = (copyMode: boolean) =>
    setDialog(
      <FormDialog
        title={copyMode ? "Copy blob" : "Rename / move blob"}
        submitLabel={copyMode ? "Copy" : "Move"}
        fields={[{ key: "to", label: "New name (use / for folders)", required: true, value: name }]}
        onClose={() => setDialog(null)}
        onSubmit={async (v) => {
          const r = await api("move", { container, from: name, to: String(v.to), copy: copyMode });
          if (!r.ok) return r.error;
          window.oneclientView.refreshExplorer();
          if (!copyMode) setName(String(v.to));
          say(copyMode ? "Copied." : "Moved.");
        }}
      />,
    );

  const fileName = name.slice(name.lastIndexOf("/") + 1);
  const editable = d.text !== undefined && !d.truncated && d.tier !== "Archive";

  return (
    <div className="kc-page">
      <div className="kc-bar">
        <span className="ab-name" title={`${container}/${name}`}>
          <span className="kc-muted">{container}/</span>
          {name}
        </span>
        <span className="kc-spacer" />
        <span className="kc-muted">{formatBytes(d.size)}</span>
        <span className="kc-muted">{d.contentType}</span>
        {d.tier && <span className="kc-badge off">{d.tier}</span>}
        <button
          className="oce-btn"
          onClick={async () => {
            const r = await api<{ path: string }>("download", { container, name });
            say(r.ok ? `Downloaded to ${r.data.path}` : r.error, !r.ok);
          }}
        >
          Download
        </button>
        <button className="oce-btn" onClick={async () => say((await copy(d.url)) ? "URL copied." : "Couldn't copy.")}>
          Copy URL
        </button>
        <button className="oce-btn" onClick={() => setDialog(<SasDialog blob={name} onClose={() => setDialog(null)} say={say} />)}>
          SAS link…
        </button>
        <button className="oce-btn" onClick={() => move(false)}>
          Rename…
        </button>
        <button className="oce-btn" onClick={() => move(true)}>
          Copy…
        </button>
        <button className="oce-btn" onClick={() => void load()}>
          Refresh
        </button>
        <button
          className="oce-btn"
          onClick={() =>
            setDialog(
              <ConfirmDialog
                title="Delete blob"
                text={`Delete "${name}"?`}
                onClose={() => setDialog(null)}
                onConfirm={async () => {
                  const r = await api("delete", { container, names: [name] });
                  if (!r.ok) return say(r.error, true);
                  window.oneclientView.setDirty(false);
                  window.oneclientView.refreshExplorer();
                  setError(`"${name}" was deleted.`);
                }}
              />,
            )
          }
        >
          Delete
        </button>
      </div>
      <div className="kc-tabs">
        {(
          [
            ["content", "Content"],
            ["properties", "Properties"],
            ["metadata", `Metadata${Object.keys(d.metadata).length ? ` (${Object.keys(d.metadata).length})` : ""}`],
          ] as const
        ).map(([t, label]) => (
          <button key={t} className={`kc-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      <div className="ab-body">
        {tab === "content" &&
          (d.tier === "Archive" ? (
            <div className="kc-message kc-muted">This blob is in the Archive tier — rehydrate it (Properties → tier) before reading it.</div>
          ) : d.text !== undefined ? (
            <div className="ab-editor">
              {d.truncated && <div className="ab-warn">Only the first 5 MB is shown; editing is off for large blobs.</div>}
              <FeatureEditor
                value={text}
                onChange={setText}
                fileName={isTextName(fileName) ? fileName : `${fileName}.txt`}
                displayPath={`${container}/${name}`}
                readOnly={!editable}
                onSave={() => editable && void saveText()}
                toolbarStart={<span className="kc-muted">{fileName}</span>}
                toolbarEnd={
                  editable ? (
                    <>
                      <button className="oce-btn" disabled={!dirty} onClick={() => setText(saved)}>
                        Revert
                      </button>
                      <button className="oce-btn oce-btn-primary" disabled={!dirty} onClick={() => void saveText()} title="Save (Ctrl+S)">
                        Save
                      </button>
                    </>
                  ) : undefined
                }
              />
            </div>
          ) : d.base64 ? (
            <div className="ab-image">
              <img src={`data:${d.contentType};base64,${d.base64}`} alt={fileName} />
            </div>
          ) : (
            <div className="kc-message kc-muted">No preview for {d.contentType} — use Download.</div>
          ))}

        {tab === "properties" && (
          <div className="ab-props">
            <table className="kc-table">
              <tbody>
                {(
                  [
                    ["URL", d.url],
                    ["Size", `${formatBytes(d.size)} (${d.size.toLocaleString()} bytes)`],
                    ["Blob type", d.blobType ?? ""],
                    ["Last modified", d.lastModified ? new Date(d.lastModified).toLocaleString() : ""],
                    ["Created", d.createdOn ? new Date(d.createdOn).toLocaleString() : ""],
                    ["ETag", d.etag ?? ""],
                    ["Content-MD5", d.contentMd5 ?? ""],
                    ["Lease", d.leaseState ?? ""],
                  ] as const
                ).map(([k, v]) => (
                  <tr key={k}>
                    <td className="kc-muted" style={{ width: 160 }}>
                      {k}
                    </td>
                    <td className="ab-mono">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h2 className="kc-h">Headers</h2>
            <div className="kc-split" style={{ maxWidth: 640 }}>
              <div className="kc-field">
                <label>Content type</label>
                <input className="kc-input" value={headers.contentType} onChange={(e) => setHeaders({ ...headers, contentType: e.target.value })} />
              </div>
              <div className="kc-field">
                <label>Cache-Control</label>
                <input className="kc-input" value={headers.cacheControl} onChange={(e) => setHeaders({ ...headers, cacheControl: e.target.value })} placeholder="e.g. max-age=3600" />
              </div>
            </div>
            <div className="kc-row" style={{ marginTop: 8 }}>
              <button
                className="oce-btn oce-btn-primary"
                onClick={async () => {
                  const r = await api("headers", { container, name, ...headers });
                  say(r.ok ? "Headers saved." : r.error, !r.ok);
                  if (r.ok) void load();
                }}
              >
                Save headers
              </button>
            </div>
            <h2 className="kc-h">Access tier</h2>
            <div className="kc-row">
              {["Hot", "Cool", "Cold", "Archive"].map((t) => (
                <button
                  key={t}
                  className={`oce-btn ${d.tier === t ? "oce-btn-on" : ""}`}
                  onClick={async () => {
                    const r = await api("tier", { container, name, tier: t });
                    say(r.ok ? `Tier set to ${t}.` : r.error, !r.ok);
                    if (r.ok) void load();
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === "metadata" && (
          <div className="ab-props">
            <table className="kc-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {meta.map(([k, v], i) => (
                  <tr key={i}>
                    <td>
                      <input className="kc-input" value={k} onChange={(e) => setMeta(meta.map((m, j) => (j === i ? [e.target.value, m[1]] : m)))} />
                    </td>
                    <td>
                      <input className="kc-input" style={{ width: "100%" }} value={v} onChange={(e) => setMeta(meta.map((m, j) => (j === i ? [m[0], e.target.value] : m)))} />
                    </td>
                    <td>
                      <button className="kc-link" onClick={() => setMeta(meta.filter((_, j) => j !== i))}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="kc-row" style={{ marginTop: 8 }}>
              <button className="oce-btn" onClick={() => setMeta([...meta, ["", ""]])}>
                + Add
              </button>
              <button
                className="oce-btn oce-btn-primary"
                onClick={async () => {
                  const r = await api("metadata", { container, name, metadata: Object.fromEntries(meta.filter(([k]) => k.trim())) });
                  say(r.ok ? "Metadata saved." : r.error, !r.ok);
                  if (r.ok) void load();
                }}
              >
                Save metadata
              </button>
            </div>
          </div>
        )}
      </div>
      {dialog}
      {toast}
    </div>
  );
}
