import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImportStatus } from "../src/import/types.js";
import { invoke } from "./api.js";
import type { SqlDialectUi } from "./dialect.js";

/**
 * Import CSV into a table: shows the head of the file with each CSV column's target (auto-mapped by name), then streams
 * the file into the table on the server — all-or-nothing by default — while this view shows progress.
 */

const params = new URLSearchParams(globalThis.location?.search ?? "");
const target = { database: params.get("database") ?? "", schema: params.get("schema") ?? "", table: params.get("table") ?? "" };
const file = params.get("file") ?? "";

interface Preview {
  delimiter: string;
  encoding: string;
  size: number;
  estimatedRows: number;
  header: string[];
  rows: string[][];
  mapping: Array<string | null>;
  columns: Array<{ name: string; type: string; kind: string; nullable: boolean; hasDefault: boolean }>;
}
type Answer<T> = { ok: true; data: T } | { ok: false; error: string };

const DELIMITERS: Array<[string, string]> = [["", "Detect"], [",", "Comma ,"], [";", "Semicolon ;"], ["\t", "Tab"], ["|", "Pipe |"]];
const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function ImportCsv({ dialect }: { dialect: SqlDialectUi }) {
  const call = useCallback(
    async <T,>(method: string, extra: Record<string, unknown> = {}): Promise<T> => {
      const r = await invoke<Answer<T>>(`${dialect.prefix}.importData`, { method, params: { ...target, ...extra } });
      if (!r.ok) throw new Error(r.error);
      return r.data;
    },
    [dialect.prefix],
  );

  const [delimiter, setDelimiter] = useState("");
  const [header, setHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [allOrNothing, setAllOrNothing] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Array<string | null>>([]);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImportStatus | null>(null);
  const jobId = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    call<Preview>("preview", { file, delimiter, header })
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        setMapping(p.mapping);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [call, delimiter, header]);

  const running = job?.state === "running";
  const used = useMemo(() => new Set(mapping.filter((m): m is string => !!m)), [mapping]);
  const missing = useMemo(() => (preview?.columns ?? []).filter((c) => !c.nullable && !c.hasDefault && !used.has(c.name)), [preview, used]);

  // Progress: polls the server's job while it runs.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const s = await call<ImportStatus>("status", { id: jobId.current });
        setJob(s);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 250);
    return () => clearInterval(t);
  }, [running, call]);

  useEffect(() => window.oneclientView.setDirty(running), [running]);

  async function start() {
    if (!preview) return;
    setError(null);
    try {
      const { id } = await call<{ id: string }>("start", { request: { file, delimiter: delimiter || preview.delimiter, header, mapping, emptyAsNull, allOrNothing } });
      jobId.current = id;
      setJob({ id, state: "running", rows: 0, committed: 0, bytes: 0, size: preview.size, elapsedMs: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const pct = job && job.size ? Math.min(100, Math.round((job.bytes / job.size) * 100)) : 0;
  // While running, a rate needs half a second of data to mean anything; the final one is exact however short the import.
  const rate = job && job.elapsedMs >= (job.state === "running" ? 500 : 20) ? Math.round(job.rows / (job.elapsedMs / 1000)) : 0;
  const finished = job && job.state !== "running";

  return (
    <div className="te-page">
      <div className="toolbar">
        <strong className="te-title">
          Import into {target.schema}.{target.table}
        </strong>
        <span className="toolbar-sep" />
        <span className="im-file" title={file}>
          {file}
        </span>
        <span className="spacer" />
        <button className="btn btn-run" disabled={!preview || running || missing.length > 0 || used.size === 0} onClick={() => void start()} title="Import the whole file">
          ▶ Import
        </button>
        {running && (
          <button className="btn" onClick={() => void call("cancel", { id: jobId.current })}>
            ■ Cancel
          </button>
        )}
      </div>
      <div className="im-body">
        {error && <div className="te-error">{error}</div>}
        {preview && (
          <>
            <div className="im-options">
              <label>
                Delimiter{" "}
                <select className="db-select" value={delimiter} disabled={running} onChange={(e) => setDelimiter(e.target.value)}>
                  {DELIMITERS.map(([v, l]) => (
                    <option key={l} value={v}>
                      {v === "" ? `${l} (${preview.delimiter === "\t" ? "Tab" : preview.delimiter})` : l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input type="checkbox" checked={header} disabled={running} onChange={(e) => setHeader(e.target.checked)} /> First row has column names
              </label>
              <label title="A blank cell becomes NULL where the column allows it (blank text stays an empty string otherwise)">
                <input type="checkbox" checked={emptyAsNull} disabled={running} onChange={(e) => setEmptyAsNull(e.target.checked)} /> Blank cells are NULL
              </label>
              <label title="One transaction for the whole file: if any row is bad, nothing is imported. Off: rows are committed in groups, and the ones before a bad row stay.">
                <input type="checkbox" checked={allOrNothing} disabled={running} onChange={(e) => setAllOrNothing(e.target.checked)} /> All or nothing
              </label>
              <span className="te-range">
                {mb(preview.size)} · {preview.encoding} · about {preview.estimatedRows.toLocaleString()} rows
              </span>
            </div>
            {missing.length > 0 && (
              <div className="te-banner">
                Needs a value but isn't mapped: {missing.map((c) => c.name).join(", ")}. Map a CSV column to {missing.length === 1 ? "it" : "them"}.
              </div>
            )}
            <div className="im-scroll">
              <table className="im-table">
                <thead>
                  <tr>
                    {preview.header.map((h, i) => (
                      <th key={i}>
                        <div className="im-name" title={h}>
                          {h || `column ${i + 1}`}
                        </div>
                        <select
                          className="db-select"
                          value={mapping[i] ?? ""}
                          disabled={running}
                          onChange={(e) =>
                            setMapping((m) => m.map((v, k) => (k === i ? e.target.value || null : v === e.target.value && e.target.value ? null : v)))
                          }
                        >
                          <option value="">— skip —</option>
                          {preview.columns.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name} ({c.type})
                            </option>
                          ))}
                        </select>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r, ri) => (
                    <tr key={ri}>
                      {preview.header.map((_, i) => (
                        <td key={i} className={mapping[i] ? "" : "im-skipped"} title={r[i]}>
                          {r[i] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {job && (
          <div className="im-progress">
            <div className="im-bar">
              <div className={`im-fill ${job.state}`} style={{ width: `${job.state === "done" ? 100 : pct}%` }} />
            </div>
            <div className="im-status">
              {job.state === "running" && `Importing… ${job.rows.toLocaleString()} rows · ${pct}%${rate ? ` · ${rate.toLocaleString()} rows/s` : ""}`}
              {job.state === "done" && `✓ Imported ${job.rows.toLocaleString()} rows in ${(job.elapsedMs / 1000).toFixed(1)} s (${rate.toLocaleString()} rows/s).`}
              {job.state === "cancelled" && `■ Cancelled. ${allOrNothing ? "Nothing was imported." : `${job.committed.toLocaleString()} row(s) were already committed.`}`}
              {job.state === "failed" && <span className="te-error">✗ {job.error}</span>}
            </div>
            {finished && job.state === "done" && (
              <button className="btn" onClick={() => window.oneclientView.openView({ viewId: `${dialect.prefix}.tableEditor`, title: `${target.schema}.${target.table}`, params: target, icon: "$(table)" })}>
                Show table data
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
