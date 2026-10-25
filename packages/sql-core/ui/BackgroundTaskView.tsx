import { ResultGrid } from "@oneclient/editor-kit/sql";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BackgroundTaskDetail } from "../src/background/types.js";
import { invoke } from "./api.js";
import { type SqlDialectUi, resolveFeatures } from "./dialect.js";

/**
 * One background task: a live clock while it runs (it keeps running without this tab), then its results and messages.
 * The task itself runs in the plugin at app level, so closing and reopening this tab, or leaving the page, never stops it.
 */

const taskId = new URLSearchParams(globalThis.location?.search ?? "").get("id") ?? "";

type Answer<T> = { ok: true; data: T } | { ok: false; error: string };

const clock = (ms: number) => {
  const total = Math.max(0, ms);
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const t = Math.floor((total % 1000) / 100);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${h ? `${h}:` : ""}${two(m)}:${two(s)}.${t}`;
};
const time = (t: number | undefined) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

const STATE_TEXT: Record<BackgroundTaskDetail["state"], string> = { running: "Running", done: "Finished", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" };

export function BackgroundTaskView({ dialect }: { dialect: SqlDialectUi }) {
  const features = resolveFeatures(dialect);
  const [detail, setDetail] = useState<BackgroundTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"results" | "messages" | "sql">("results");
  const [now, setNow] = useState(Date.now());
  /** The browser's clock when `detail` arrived: elapsed = what the server said + the time since, whatever either clock says. */
  const fetchedAt = useRef(Date.now());

  const call = useCallback(
    async <T,>(method: string): Promise<T> => {
      const r = await invoke<Answer<T>>(`${dialect.prefix}.backgroundTasks`, { method, id: taskId });
      if (!r.ok) throw new Error(r.error);
      return r.data;
    },
    [dialect.prefix],
  );

  const load = useCallback(async () => {
    try {
      const d = await call<BackgroundTaskDetail>("get");
      fetchedAt.current = Date.now();
      setDetail(d);
      setError(null);
      return d;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const running = detail?.state === "running";
  // While running: refresh the state every second, tick the clock every 100 ms. A finished task stops both.
  useEffect(() => {
    if (!running) return;
    const poll = setInterval(() => void load(), 1000);
    const tick = setInterval(() => setNow(Date.now()), 100);
    return () => (clearInterval(poll), clearInterval(tick));
  }, [running, load]);

  // Land on the Messages tab when there are no result sets (an UPDATE, or a failure).
  const settled = detail && detail.state !== "running";
  useEffect(() => {
    if (settled && (detail.result?.resultSets.length ?? 0) === 0) setTab("messages");
  }, [settled, detail?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !detail) return <div className="results-panel"><div className="te-error">{error}</div></div>;
  if (!detail) return <div className="results-panel"><div className="empty">Loading…</div></div>;

  const elapsed = running ? detail.elapsedMs + (now - fetchedAt.current) : detail.elapsedMs;
  const result = detail.result;
  const sets = result?.resultSets ?? [];

  async function act(method: "cancel" | "remove" | "rerun") {
    try {
      const r = await call<unknown>(method);
      if (method === "rerun") {
        const t = r as { id: string; title: string };
        window.oneclientView.openView({ viewId: `${dialect.prefix}.backgroundTask`, title: t.title, icon: "$(clock)", params: { id: t.id } });
      } else if (method === "remove") {
        setError("Removed from Background Tasks. You can close this tab.");
        setDetail(null);
        return;
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="results-panel bt-page">
      <div className="toolbar">
        <strong className="te-title bt-title" title={detail.sql}>
          {detail.title}
        </strong>
        <span className={`bt-state ${detail.state}`}>{STATE_TEXT[detail.state]}</span>
        <span className={`bt-clock ${detail.state}`} title="Time it has run">
          ⏱ {clock(elapsed)}
        </span>
        <span className="te-range">
          started {time(detail.startedAt)}
          {detail.endedAt ? ` · ended ${time(detail.endedAt)}` : ""}
          {detail.database ? ` · ${detail.database}` : ""}
        </span>
        <span className="spacer" />
        {running && (
          <button className="btn" onClick={() => void act("cancel")} title="Stop the query on the server (the same as Stop in the Tasks panel)">
            ■ Cancel
          </button>
        )}
        <button
          className="btn"
          onClick={() => window.oneclientView.openView({ viewId: `${dialect.prefix}.query`, title: detail.title.slice(0, 28), params: { windowId: `bt-${detail.id}-${Date.now()}`, sql: detail.sql.slice(0, 20000), ...(detail.database ? { database: detail.database } : {}), title: detail.title.slice(0, 28) } })}
          title="Open the script in a query window"
        >
          Open SQL
        </button>
        <button className="btn" onClick={() => void act("rerun")} disabled={running} title="Run the same script again as a new background task">
          ↻ Run again
        </button>
        <button className="btn" onClick={() => void act("remove")} disabled={running} title="Remove this task and its saved results">
          Remove
        </button>
      </div>
      {error && <div className="te-error">{error}</div>}
      <div className="results-tabs">
        <button className={tab === "results" ? "active" : ""} onClick={() => setTab("results")}>
          Results{sets.length > 1 ? ` (${sets.length})` : ""}
        </button>
        <button className={tab === "messages" ? "active" : ""} onClick={() => setTab("messages")}>
          Messages{detail.hasErrors ? " ⚠" : ""}
        </button>
        <button className={tab === "sql" ? "active" : ""} onClick={() => setTab("sql")}>
          SQL
        </button>
      </div>
      <div className="results-body">
        {tab === "sql" ? (
          <pre className="messages bt-sql">{detail.sql}</pre>
        ) : running ? (
          <div className="bt-wait">
            <div className="bt-big">{clock(elapsed)}</div>
            <div>Running in the background — the results appear here when it finishes.</div>
            <div className="te-range">You can close this tab, switch connections or keep working: it runs in {dialect.productName} on its own connection. It's listed in BACKGROUND TASKS and in the Tasks panel.</div>
          </div>
        ) : tab === "messages" ? (
          <pre className="messages">
            {detail.state === "interrupted" || detail.state === "failed" ? <div className="msg-error">{detail.error}</div> : null}
            {(result?.messages ?? []).map((m, i) => (
              <div key={i} className={m.kind === "error" ? "msg-error" : undefined}>
                {m.text}
              </div>
            ))}
            {!detail.error && !(result?.messages.length) ? "Commands completed successfully." : null}
          </pre>
        ) : sets.length === 0 ? (
          <div className="empty">{detail.state === "interrupted" ? "oneClient was closed while this was running, so there are no results." : "The script returned no result sets — see Messages."}</div>
        ) : (
          <>
            {detail.keptRows !== undefined && <div className="te-banner">Reopened after a restart: the first {detail.keptRows.toLocaleString()} rows of each result are kept.</div>}
            <div className={`result-sets ${sets.length === 1 ? "single" : ""}`}>
              {sets.map((rs, i) => (
                <ResultGrid key={i} result={rs} fill={sets.length === 1} dialect={dialect.gridDialect} exports={features.resultExport} cellViewer={features.cellViewer} />
              ))}
            </div>
          </>
        )}
      </div>
      <div className={`statusbar ${detail.state === "done" ? "ok" : detail.state === "running" ? "running" : detail.state === "cancelled" || detail.state === "interrupted" ? "warn" : "error"}`}>
        <span className="status-text">
          {STATE_TEXT[detail.state]} · {clock(elapsed)}
        </span>
        <span className="spacer" />
        <span>{detail.rows.toLocaleString()} rows</span>
        <span>
          {detail.resultSets} result set{detail.resultSets === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
