import { useEffect, useState } from "react";
import type { QueryRun } from "./api.js";
import type { ToResults, WindowUpdate } from "./protocol.js";
import { formatElapsed } from "./format.js";
import { ResultGrid, guessTables } from "@oneclient/editor-kit/sql";
import { type SqlDialectUi, resolveFeatures } from "./dialect.js";

/**
 * "Query Results" — a SQL plugin's view in the app's shared bottom panel. Shows the
 * Results grids / Messages / status of whichever query window was last active,
 * like SSMS's results pane but in one shared place.
 */
export function ResultsPanel({ dialect }: { dialect: SqlDialectUi }) {
  const [windows, setWindows] = useState<Map<string, WindowUpdate>>(new Map());
  const [active, setActive] = useState<{ windowId: string; title: string } | null>(null);
  const [tab, setTab] = useState<"results" | "messages">("results");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const off = window.oneclientView.onMessage((raw) => {
      const msg = raw as ToResults;
      if (msg.type === "snapshot") {
        setWindows(new Map(msg.windows.map((w) => [w.windowId, w])));
        setActive(msg.active);
      } else if (msg.type === "activate") {
        setActive({ windowId: msg.windowId, title: msg.title });
      } else if (msg.type === "update") {
        setWindows((prev) => new Map(prev).set(msg.windowId, msg));
        setActive({ windowId: msg.windowId, title: msg.title });
        if (msg.state.kind === "done") {
          // Show Messages when there's nothing else to look at.
          setTab(msg.state.run.resultSets.length === 0 ? "messages" : "results");
        } else if (msg.state.kind === "failed") {
          setTab("messages");
        }
      }
    });
    window.oneclientView.postMessage({ type: "hello" });
    return off;
  }, []);

  const current = active ? windows.get(active.windowId) : undefined;
  const running = current?.state.kind === "running";

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  if (!active || !current) {
    return (
      <div className="results-panel">
        <div className="empty">Run a query (F5) in a {dialect.productName} query window to see results here.</div>
      </div>
    );
  }

  const run = current.state.kind === "done" ? current.state.run : null;
  const elapsed = current.state.kind === "running" ? now - current.state.started : (run?.elapsedMs ?? 0);
  const totalRows = run ? run.resultSets.reduce((n, rs) => n + rs.totalRows, 0) : 0;
  const goToLine = (line: number) => window.oneclientView.postMessage({ type: "goToLine", windowId: current.windowId, line });

  return (
    <div className="results-panel">
      <div className="results-tabs">
        <button className={tab === "results" ? "active" : ""} onClick={() => setTab("results")}>
          Results{run && run.resultSets.length > 1 ? ` (${run.resultSets.length})` : ""}
        </button>
        <button className={tab === "messages" ? "active" : ""} onClick={() => setTab("messages")}>
          Messages{run?.hasErrors ? " ⚠" : ""}
        </button>
        <span className="spacer" />
        <span className="results-source" title="Query window these results belong to">
          {current.title}
        </span>
      </div>
      <div className="results-body">
        {tab === "results" ? <ResultsView run={run} running={running} sql={current.sql} dialect={dialect} /> : <MessagesView update={current} onGoToLine={goToLine} />}
      </div>
      <div className={`statusbar ${statusClass(current)}`}>
        <span className="status-text">{statusText(current)}</span>
        <span className="spacer" />
        {current.info && <span>{`${current.info.server} (${current.info.version})`}</span>}
        {current.info && <span>{current.info.login}</span>}
        {current.info?.database && <span>{current.info.database}</span>}
        <span>{formatElapsed(elapsed)}</span>
        <span>{totalRows.toLocaleString()} rows</span>
      </div>
    </div>
  );
}

function ResultsView({ run, running, sql, dialect }: { run: QueryRun | null; running: boolean; sql: string | undefined; dialect: SqlDialectUi }) {
  const features = resolveFeatures(dialect);
  if (!run) return <div className="empty">{running ? "Executing query…" : "No results."}</div>;
  if (run.resultSets.length === 0) return <div className="empty">The query returned no result sets — see Messages.</div>;
  const single = run.resultSets.length === 1;
  const tables = sql ? guessTables(sql) : [];
  return (
    <div className={`result-sets ${single ? "single" : ""}`}>
      {run.resultSets.map((rs, i) => (
        <ResultGrid key={i} result={rs} fill={single} dialect={dialect.gridDialect} tableHint={tables[i]} exports={features.resultExport} cellViewer={features.cellViewer} />
      ))}
    </div>
  );
}

function MessagesView({ update, onGoToLine }: { update: WindowUpdate; onGoToLine: (line: number) => void }) {
  const { state } = update;
  if (state.kind === "failed") {
    return (
      <pre className="messages">
        <span className="msg-error">{state.error}</span>
      </pre>
    );
  }
  if (state.kind === "running") return <div className="empty">Executing query…</div>;
  if (state.run.messages.length === 0) return <pre className="messages">Commands completed successfully.</pre>;
  return (
    <pre className="messages">
      {state.run.messages.map((m, i) => (
        <div
          key={i}
          className={m.kind === "error" ? "msg-error" : undefined}
          onDoubleClick={() => m.line && onGoToLine(m.line)}
          title={m.line ? "Double-click to go to the line" : undefined}
        >
          {m.text}
        </div>
      ))}
    </pre>
  );
}

function statusClass(u: WindowUpdate): string {
  if (u.state.kind === "running") return "running";
  if (u.state.kind === "failed") return "error";
  return u.state.run.cancelled ? "warn" : u.state.run.hasErrors ? "error" : "ok";
}

function statusText(u: WindowUpdate): string {
  if (u.state.kind === "running") return "Executing query…";
  if (u.state.kind === "failed") return "Query failed.";
  if (u.state.run.cancelled) return "Query was cancelled.";
  return u.state.run.hasErrors ? "Query completed with errors." : "Query executed successfully.";
}
