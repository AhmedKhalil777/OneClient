import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog, FormDialog, api, open, qs, useToast } from "./kit.js";
import { SasDialog, formatBytes } from "./Blob.js";

interface BlobRow {
  name: string;
  label: string;
  size: number;
  contentType?: string;
  lastModified?: string;
  tier?: string;
}
interface Level {
  folders: Array<{ prefix: string; label: string }>;
  blobs: BlobRow[];
  continuation?: string;
}

/** Reads a dropped / picked file as base64 (without the data: prefix). */
const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("Couldn't read the file."));
    r.readAsDataURL(file);
  });

/** One container, one folder at a time: browse, upload (picker or drag & drop), download, delete, share. */
export function Browser() {
  const [containers, setContainers] = useState<Array<{ name: string; publicAccess: string }>>([]);
  const [container, setContainer] = useState(qs.get("container") ?? "");
  const [prefix, setPrefix] = useState(qs.get("prefix") ?? "");
  const [level, setLevel] = useState<Level | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState("");
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<React.ReactNode>(null);
  const [toast, say] = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api<Array<{ name: string; publicAccess: string }>>("containers").then((r) => {
      if (!r.ok) return setError(r.error);
      const list = r.data as unknown as Array<{ name: string; publicAccess: string }>;
      setContainers(list);
      setContainer((c) => c || list[0]?.name || "");
    });
  }, []);

  const load = useCallback(
    async (more = false) => {
      if (!container) return;
      const r = await api<Level>("list", { container, prefix, ...(more && level?.continuation ? { continuation: level.continuation } : {}) });
      if (!r.ok) return setError(r.error);
      setError("");
      const data = r.data as unknown as Level;
      setLevel((prev) => (more && prev ? { folders: [...prev.folders, ...data.folders], blobs: [...prev.blobs, ...data.blobs], ...(data.continuation ? { continuation: data.continuation } : {}) } : data));
      if (!more) setSelected(new Set());
    },
    [container, prefix, level?.continuation],
  );

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, prefix]);

  const uploadFiles = async (files: File[]) => {
    if (!files.length || !container) return;
    let ok = 0;
    const failed: string[] = [];
    for (const [i, f] of files.entries()) {
      setBusy(`Uploading ${i + 1}/${files.length}: ${f.name}`);
      try {
        const r = await api("upload", { container, name: `${prefix}${f.name}`, base64: await readBase64(f), contentType: f.type || undefined, overwrite });
        if (r.ok) ok++;
        else failed.push(`${f.name}: ${r.error}`);
      } catch (err) {
        failed.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setBusy("");
    say(failed.length ? `Uploaded ${ok}; ${failed.length} failed — ${failed[0]}` : `Uploaded ${ok} file${ok === 1 ? "" : "s"}.`, failed.length > 0);
    window.oneclientView.refreshExplorer();
    await load(false);
  };

  const crumbs = prefix.split("/").filter(Boolean);
  const access = containers.find((c) => c.name === container)?.publicAccess;
  const allNames = level?.blobs.map((b) => b.name) ?? [];

  return (
    <div
      className={`kc-page ${dragging ? "ab-drop" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void uploadFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="kc-bar">
        <select
          className="kc-select"
          value={container}
          onChange={(e) => {
            setContainer(e.target.value);
            setPrefix("");
          }}
        >
          {containers.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="ab-crumbs">
          <button className="kc-link" onClick={() => setPrefix("")}>
            {container || "—"}
          </button>
          {crumbs.map((c, i) => (
            <span key={i}>
              {" / "}
              <button className="kc-link" onClick={() => setPrefix(`${crumbs.slice(0, i + 1).join("/")}/`)}>
                {c}
              </button>
            </span>
          ))}
        </span>
        {access && access !== "private" && <span className="kc-badge">public: {access}</span>}
        <span className="kc-spacer" />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => void uploadFiles([...(e.target.files ?? [])]).then(() => fileInput.current && (fileInput.current.value = ""))} />
        <label className="kc-row kc-muted" style={{ gap: 4 }} title="Replace blobs that already exist">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> overwrite
        </label>
        <button className="oce-btn oce-btn-primary" disabled={!container || busy !== ""} onClick={() => fileInput.current?.click()}>
          Upload…
        </button>
        <button
          className="oce-btn"
          disabled={!container}
          onClick={() =>
            setDialog(
              <FormDialog
                title="New folder"
                submitLabel="Create"
                fields={[{ key: "name", label: "Folder name", required: true }]}
                onClose={() => setDialog(null)}
                onSubmit={async (v) => {
                  const r = await api("createFolder", { container, prefix, name: String(v.name) });
                  if (!r.ok) return r.error;
                  window.oneclientView.refreshExplorer();
                  await load(false);
                }}
              />,
            )
          }
        >
          New folder
        </button>
        <button className="oce-btn" disabled={!container} onClick={() => setDialog(<SasDialog onClose={() => setDialog(null)} say={say} />)}>
          Share…
        </button>
        <button className="oce-btn" onClick={() => void load(false)}>
          Refresh
        </button>
      </div>
      {busy && <div className="ab-busy">{busy}</div>}
      {selected.size > 0 && (
        <div className="ab-selection">
          {selected.size} selected
          <button
            className="oce-btn"
            onClick={async () => {
              for (const n of selected) {
                const r = await api<{ path: string }>("download", { container, name: n });
                if (!r.ok) return say(r.error, true);
              }
              say(`Downloaded ${selected.size} file(s) to your Downloads folder.`);
            }}
          >
            Download
          </button>
          <button
            className="oce-btn"
            onClick={() =>
              setDialog(
                <ConfirmDialog
                  title="Delete blobs"
                  text={`Delete ${selected.size} blob${selected.size === 1 ? "" : "s"}?`}
                  onClose={() => setDialog(null)}
                  onConfirm={async () => {
                    const r = await api("delete", { container, names: [...selected] });
                    if (!r.ok) return say(r.error, true);
                    window.oneclientView.refreshExplorer();
                    await load(false);
                  }}
                />,
              )
            }
          >
            Delete
          </button>
        </div>
      )}
      <div className="kc-body">
        {error ? (
          <div className="kc-error">{error}</div>
        ) : !level ? (
          <div className="kc-muted">{container ? "Loading…" : "This account has no containers yet — right-click the connection → New Container…"}</div>
        ) : (
          <>
            <table className="kc-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input type="checkbox" checked={allNames.length > 0 && selected.size === allNames.length} onChange={(e) => setSelected(e.target.checked ? new Set(allNames) : new Set())} />
                  </th>
                  <th>Name</th>
                  <th style={{ width: 100 }}>Size</th>
                  <th style={{ width: 180 }}>Content type</th>
                  <th style={{ width: 170 }}>Modified</th>
                  <th style={{ width: 70 }}>Tier</th>
                </tr>
              </thead>
              <tbody>
                {prefix && (
                  <tr>
                    <td />
                    <td>
                      <button className="kc-link" onClick={() => setPrefix(crumbs.length > 1 ? `${crumbs.slice(0, -1).join("/")}/` : "")}>
                        ↰ ..
                      </button>
                    </td>
                    <td colSpan={4} />
                  </tr>
                )}
                {level.folders.map((f) => (
                  <tr key={f.prefix}>
                    <td />
                    <td>
                      <button className="kc-link" onClick={() => setPrefix(f.prefix)}>
                        📁 {f.label}
                      </button>
                    </td>
                    <td colSpan={4} className="kc-muted">
                      folder
                    </td>
                  </tr>
                ))}
                {level.blobs
                  .filter((b) => b.label !== ".keep")
                  .map((b) => (
                    <tr key={b.name}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(b.name)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(b.name);
                            else next.delete(b.name);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td>
                        <button className="kc-link" onClick={() => open("azblob.blob", b.label, { container, name: b.name }, "$(file)")}>
                          {b.label}
                        </button>
                      </td>
                      <td className="kc-muted">{formatBytes(b.size)}</td>
                      <td className="kc-muted">{b.contentType ?? ""}</td>
                      <td className="kc-muted">{b.lastModified ? new Date(b.lastModified).toLocaleString() : ""}</td>
                      <td className="kc-muted">{b.tier ?? ""}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {level.folders.length === 0 && level.blobs.filter((b) => b.label !== ".keep").length === 0 && <div className="kc-message kc-muted">Empty — drop files here or use Upload….</div>}
            {level.continuation && (
              <div className="kc-row" style={{ marginTop: 8 }}>
                <button className="oce-btn" onClick={() => void load(true)}>
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {dragging && <div className="ab-dropzone">Drop files to upload to {container}/{prefix}</div>}
      {dialog}
      {toast}
    </div>
  );
}
