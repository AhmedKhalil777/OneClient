import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSqlCompletionProvider } from "./completion.js";
import {
  type QueryRun,
  type ServerInfo,
  autorun,
  cancelQuery,
  executeQuery,
  initialDatabase,
  initialSql,
  listDatabases,
  serverInfo,
} from "./api.js";
import { ResultGrid } from "./ResultGrid.js";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor.js";

type Status =
  | { kind: "idle" }
  | { kind: "running"; started: number; queryId: string }
  | { kind: "done"; run: QueryRun }
  | { kind: "failed"; error: string };

/** One SSMS query window: editor on top, Results/Messages below, status bar at the bottom. */
export function QueryWindow() {
  const [sql, setSql] = useState(initialSql);
  const [database, setDatabase] = useState<string | undefined>(initialDatabase);
  const [databases, setDatabases] = useState<string[]>([]);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [tab, setTab] = useState<"results" | "messages">("results");
  const [showResults, setShowResults] = useState(true);
  const [split, setSplit] = useState(0.45); // editor share of the height
  const [now, setNow] = useState(Date.now());
  const editorRef = useRef<SqlEditorHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // IntelliSense reads the dropdown's database through a ref so the provider is created once.
  const databaseRef = useRef(database);
  databaseRef.current = database;
  const completion = useMemo(() => createSqlCompletionProvider(() => databaseRef.current), []);
  const completionProviders = useMemo(() => [completion.provider], [completion]);

  const running = status.kind === "running";

  const execute = useCallback(
    async (override?: { sql: string; lineOffset: number }) => {
      if (status.kind === "running") return;
      const runnable = override ?? editorRef.current?.getRunnable() ?? { sql, lineOffset: 1 };
      if (!runnable.sql.trim()) return;
      const queryId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setStatus({ kind: "running", started: Date.now(), queryId });
      setShowResults(true);
      try {
        const run = await executeQuery({ queryId, sql: runnable.sql, database, lineOffset: runnable.lineOffset });
        if (!run.ok) {
          setStatus({ kind: "failed", error: run.error });
          setTab("messages");
          return;
        }
        setStatus({ kind: "done", run });
        if (run.database) setDatabase(run.database);
        // The script may have created/altered/dropped objects — refresh IntelliSense lazily.
        if (/\b(CREATE|ALTER|DROP|SELECT\s+[\s\S]*\bINTO|sp_rename)\b/i.test(runnable.sql)) completion.invalidate();
        // SSMS shows Messages when there's nothing else to look at.
        setTab(run.resultSets.length === 0 || (run.hasErrors && run.resultSets.length === 0) ? "messages" : "results");
      } catch (err) {
        setStatus({ kind: "failed", error: err instanceof Error ? err.message : String(err) });
        setTab("messages");
      }
    },
    [status.kind, sql, database, completion],
  );

  const cancel = useCallback(() => {
    if (status.kind === "running") void cancelQuery(status.queryId);
  }, [status]);

  // Initial load: server info, database list, the session's current database, then autorun (Select Top 1000).
  useEffect(() => {
    void serverInfo().then(setInfo).catch(() => undefined);
    void listDatabases().then(setDatabases).catch(() => undefined);
    void (async () => {
      if (!initialDatabase) {
        // An empty run just opens this window's session and reports DB_NAME().
        const r = await executeQuery({ queryId: "init", sql: "" }).catch(() => null);
        if (r?.ok && r.database) setDatabase(r.database);
      }
      if (autorun && initialSql) void execute({ sql: initialSql, lineOffset: 1 });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  // SSMS shortcuts: F5 / Ctrl+E execute, Alt+Break cancel, Ctrl+R toggle the results pane.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "F5" || (mod && e.key.toLowerCase() === "e")) {
        e.preventDefault();
        void execute();
      } else if ((e.altKey && (e.key === "Pause" || e.key === "Cancel")) || (e.key === "Escape" && running)) {
        e.preventDefault();
        cancel();
      } else if (mod && e.key.toLowerCase() === "r") {
        e.preventDefault();
        setShowResults((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [execute, cancel, running]);

  function startSplitDrag(e: React.MouseEvent) {
    e.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => setSplit(Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("dragging");
    };
    document.body.classList.add("dragging");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const run = status.kind === "done" ? status.run : null;
  const elapsed = status.kind === "running" ? now - status.started : (run?.elapsedMs ?? 0);
  const totalRows = run ? run.resultSets.reduce((n, rs) => n + rs.totalRows, 0) : 0;
  const dbOptions = database && !databases.includes(database) ? [database, ...databases] : databases;

  return (
    <div className="window">
      <div className="toolbar">
        <select
          className="db-select"
          value={database ?? ""}
          onChange={(e) => setDatabase(e.target.value)}
          disabled={running}
          title="Available databases"
        >
          {!database && <option value="">(default)</option>}
          {dbOptions.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button className="btn btn-run" onClick={() => void execute()} disabled={running} title="Execute (F5) — runs the selection if there is one">
          ▶ Execute
        </button>
        <button className="btn" onClick={cancel} disabled={!running} title="Cancel executing query (Alt+Break)">
          ■ Cancel
        </button>
        <span className="toolbar-sep" />
        <button className="btn" onClick={() => setShowResults((v) => !v)} title="Show/hide results pane (Ctrl+R)">
          {showResults ? "Hide Results" : "Show Results"}
        </button>
      </div>

      <div className="body" ref={bodyRef}>
        <div className="editor-pane" style={{ flexBasis: showResults ? `${split * 100}%` : "100%" }}>
          <SqlEditor ref={editorRef} value={sql} onChange={setSql} completionProviders={completionProviders} />
        </div>

        {showResults && (
          <>
            <div className="splitter" onMouseDown={startSplitDrag} />
            <div className="results-pane">
              <div className="results-tabs">
                <button className={tab === "results" ? "active" : ""} onClick={() => setTab("results")}>
                  ▦ Results
                </button>
                <button className={tab === "messages" ? "active" : ""} onClick={() => setTab("messages")}>
                  ✉ Messages
                </button>
              </div>
              <div className="results-body">
                {tab === "results" && <ResultsView run={run} running={running} />}
                {tab === "messages" && (
                  <MessagesView status={status} onGoToLine={(line) => editorRef.current?.goToLine(line)} />
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className={`statusbar ${statusClass(status)}`}>
        <span className="status-text">{statusText(status)}</span>
        <span className="spacer" />
        <span>{info ? `${info.server} (${info.version})` : ""}</span>
        <span>{info?.login}</span>
        <span>{database ?? ""}</span>
        <span>{formatElapsed(elapsed)}</span>
        <span>{totalRows.toLocaleString()} rows</span>
      </div>
    </div>
  );
}

function ResultsView({ run, running }: { run: QueryRun | null; running: boolean }) {
  if (!run) return <div className="empty">{running ? "Executing query…" : "Press F5 to execute the query."}</div>;
  if (run.resultSets.length === 0) return <div className="empty">The query returned no result sets — see Messages.</div>;
  const single = run.resultSets.length === 1;
  return (
    <div className={`result-sets ${single ? "single" : ""}`}>
      {run.resultSets.map((rs, i) => (
        <ResultGrid key={i} result={rs} fill={single} />
      ))}
    </div>
  );
}

function MessagesView({ status, onGoToLine }: { status: Status; onGoToLine: (line: number) => void }) {
  if (status.kind === "failed") return <pre className="messages"><span className="msg-error">{status.error}</span></pre>;
  if (status.kind !== "done") return <div className="empty">{status.kind === "running" ? "Executing query…" : "No messages."}</div>;
  if (status.run.messages.length === 0) return <pre className="messages">Commands completed successfully.</pre>;
  return (
    <pre className="messages">
      {status.run.messages.map((m, i) => (
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

function statusClass(status: Status): string {
  if (status.kind === "running") return "running";
  if (status.kind === "failed") return "error";
  if (status.kind === "done") return status.run.cancelled ? "warn" : status.run.hasErrors ? "error" : "ok";
  return "";
}

function statusText(status: Status): string {
  switch (status.kind) {
    case "idle":
      return "Ready";
    case "running":
      return "Executing query…";
    case "failed":
      return "Query failed.";
    case "done":
      if (status.run.cancelled) return "Query was cancelled.";
      return status.run.hasErrors ? "Query completed with errors." : "Query executed successfully.";
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
