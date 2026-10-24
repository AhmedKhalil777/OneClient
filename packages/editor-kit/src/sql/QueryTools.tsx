import { useCallback, useEffect, useRef, useState } from "react";
import type { RiskyStatement } from "./guard.js";
import { copyText } from "./ResultGrid.js";

/** One run from a query window, as the plugin's history store keeps it. */
export interface HistoryEntry {
  id: string;
  at: number;
  sql: string;
  database: string | null;
  status: "ok" | "error" | "cancelled";
  elapsedMs: number;
  rows: number;
  error?: string;
}

export interface HistoryPanelProps {
  /** Newest first; the plugin's `<prefix>.history` command. */
  load: (search: string) => Promise<HistoryEntry[]>;
  /** Removes one entry, or all of them with no id. */
  remove: (id?: string) => Promise<unknown>;
  /** Put the SQL into the editor: replace its text, or insert at the caret. */
  onUse: (sql: string, mode: "replace" | "insert") => void;
  /** Run the SQL now (it goes into the editor too). */
  onRun: (sql: string) => void;
  onClose: () => void;
  /** Bump to reload, e.g. after a run finishes. */
  refreshToken?: number;
}

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};
const ms = (n: number) => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`);

/**
 * Query history side panel for a query window: search, then click an entry to load it into the editor (Ctrl/⌘-click
 * inserts at the caret, double-click runs it). Every run of this connection is there — across windows and restarts.
 */
export function HistoryPanel({ load, remove, onUse, onRun, onClose, refreshToken }: HistoryPanelProps) {
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(() => {
    load(search)
      .then((e) => (setEntries(e), setError(null)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [load, search]);

  useEffect(() => {
    const t = setTimeout(reload, 150);
    return () => clearTimeout(t);
  }, [reload, refreshToken]);
  useEffect(() => input.current?.focus(), []);

  return (
    <aside className="sqlh">
      <div className="sqlh-head">
        <strong>Query History</strong>
        <span className="sqlg-spacer" />
        {confirmClear ? (
          <>
            <span className="sqlg-dim">Clear all?</span>
            <button className="sqlg-btn danger" onClick={() => void remove().then(() => (setConfirmClear(false), reload()))}>
              Clear
            </button>
            <button className="sqlg-btn" onClick={() => setConfirmClear(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="sqlg-btn" onClick={() => setConfirmClear(true)} disabled={!entries?.length} title="Delete this connection's history">
            Clear…
          </button>
        )}
        <button className="sqlg-btn" onClick={onClose} title="Close history">
          ✕
        </button>
      </div>
      <input ref={input} className="sqlg-filter sqlh-search" placeholder="Search history…" value={search} onChange={(e) => setSearch(e.target.value)} spellCheck={false} onKeyDown={(e) => e.key === "Escape" && (search ? setSearch("") : onClose())} />
      <div className="sqlh-list">
        {error && <div className="sqlh-empty error">{error}</div>}
        {entries && !entries.length && <div className="sqlh-empty">{search ? "Nothing matches." : "Queries you run on this connection appear here."}</div>}
        {entries?.map((e) => (
          <div
            key={e.id}
            className={`sqlh-item ${active === e.id ? "active" : ""}`}
            title={`${new Date(e.at).toLocaleString()}\n\nClick: open in editor · Ctrl+click: insert at caret · Double-click: run`}
            onClick={(ev) => (setActive(e.id), onUse(e.sql, ev.ctrlKey || ev.metaKey ? "insert" : "replace"))}
            onDoubleClick={() => onRun(e.sql)}
          >
            <div className="sqlh-meta">
              <span className={`sqlh-dot ${e.status}`} title={e.status === "ok" ? "Succeeded" : e.status === "cancelled" ? "Cancelled" : (e.error ?? "Failed")} />
              <span>{ago(e.at)}</span>
              {e.database && <span className="sqlh-db">{e.database}</span>}
              <span className="sqlg-spacer" />
              <span>{ms(e.elapsedMs)}</span>
              {e.status === "ok" && <span>{e.rows.toLocaleString()} rows</span>}
              <button className="sqlh-x" title="Copy SQL" onClick={(ev) => (ev.stopPropagation(), copyText(e.sql))}>
                ⧉
              </button>
              <button className="sqlh-x" title="Remove from history" onClick={(ev) => (ev.stopPropagation(), void remove(e.id).then(reload))}>
                ✕
              </button>
            </div>
            <pre className="sqlh-sql">{e.sql.length > 600 ? `${e.sql.slice(0, 600)}…` : e.sql}</pre>
            {e.status === "error" && e.error && <div className="sqlh-error">{e.error}</div>}
          </div>
        ))}
      </div>
    </aside>
  );
}

/**
 * Safe mode's question before a risky script runs (see findRiskyStatements). Enter runs, Esc cancels; "Turn off safe
 * mode" runs it and stops asking (the query window remembers that for every window).
 */
export function SafeModeDialog({ risks, onRun, onCancel, onDisable }: { risks: RiskyStatement[]; onRun: () => void; onCancel: () => void; onDisable: () => void }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="sqlg-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}>
      <div className="sqlg-dialog" role="alertdialog" aria-labelledby="sqlsafe-title">
        <div className="sqlg-dialog-title" id="sqlsafe-title">
          ⚠ Run {risks.length === 1 ? "a statement" : `${risks.length} statements`} that can't be undone?
        </div>
        <ul className="sqlg-risks">
          {risks.map((r, i) => (
            <li key={i}>
              <strong>{r.reason}</strong>
              <code>{r.text}</code>
            </li>
          ))}
        </ul>
        <div className="sqlg-dialog-note">Safe mode asks before UPDATE or DELETE without WHERE, DROP, TRUNCATE and ALTER … DROP. Wrap the script in a transaction to be able to roll it back.</div>
        <div className="sqlg-dialog-actions">
          <button className="sqlg-link" onClick={onDisable}>
            Turn off safe mode
          </button>
          <span className="sqlg-spacer" />
          <button className="sqlg-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="sqlg-btn danger" ref={ref} onClick={onRun}>
            Run anyway
          </button>
        </div>
      </div>
    </div>
  );
}
