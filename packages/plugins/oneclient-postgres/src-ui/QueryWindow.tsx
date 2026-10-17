import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ServerInfo,
  autorun,
  cancelQuery,
  executeQuery,
  initialDatabase,
  initialSql,
  listDatabases,
  serverInfo,
  windowId,
} from "./api.js";
import { createSqlCompletionProvider } from "./completion.js";
import { formatElapsed } from "./format.js";
import type { ToQueryWindow } from "./protocol.js";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor.js";

type Status =
  | { kind: "idle" }
  | { kind: "running"; started: number; queryId: string }
  | { kind: "done"; hasErrors: boolean; cancelled: boolean; elapsedMs: number; rows: number }
  | { kind: "failed"; error: string };

const RESULTS_VIEW = "postgres.results";

/**
 * One PostgreSQL query window: toolbar + editor. Results and messages show in
 * the app's shared bottom panel ("Query Results"), not inside this tab — the
 * backend streams them there and tells this window when the run is done.
 */
export function QueryWindow() {
  const [sql, setSql] = useState(initialSql);
  const [database, setDatabase] = useState<string | undefined>(initialDatabase);
  const [databases, setDatabases] = useState<string[]>([]);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [now, setNow] = useState(Date.now());
  const editorRef = useRef<SqlEditorHandle>(null);
  const title = useMemo(() => document.title, []);

  const databaseRef = useRef(database);
  databaseRef.current = database;
  const infoRef = useRef(info);
  infoRef.current = info;
  const completion = useMemo(() => createSqlCompletionProvider(() => databaseRef.current), []);
  const completionProviders = useMemo(() => [completion.provider], [completion]);

  const running = status.kind === "running";

  const execute = useCallback(
    (override?: { sql: string; lineOffset: number }) => {
      if (status.kind === "running") return;
      const runnable = override ?? editorRef.current?.getRunnable() ?? { sql, lineOffset: 1 };
      if (!runnable.sql.trim()) return;
      const queryId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setStatus({ kind: "running", started: Date.now(), queryId });
      window.oneclientView.postMessage({
        type: "execute",
        windowId,
        title: windowTitle(),
        queryId,
        sql: runnable.sql,
        database: databaseRef.current,
        lineOffset: runnable.lineOffset,
        info: infoRef.current && { ...infoRef.current, database: databaseRef.current },
      });
      window.oneclientView.revealView(RESULTS_VIEW);
      // The script may create/alter/drop objects — refresh IntelliSense lazily.
      if (/\b(CREATE|ALTER|DROP|SELECT\s+[\s\S]*\bINTO|RENAME|search_path)\b/i.test(runnable.sql)) completion.invalidate();
    },
    [status.kind, sql, completion],
  );

  const cancel = useCallback(() => {
    if (status.kind === "running") void cancelQuery(status.queryId);
  }, [status]);

  // Backend → this window (filter: every window of the connection gets these).
  useEffect(() => {
    const off = window.oneclientView.onMessage((raw) => {
      const msg = raw as ToQueryWindow;
      if (msg.windowId !== windowId) return;
      if (msg.type === "done") {
        if (msg.database) setDatabase(msg.database);
        setStatus({ kind: "done", hasErrors: msg.hasErrors, cancelled: msg.cancelled, elapsedMs: msg.elapsedMs, rows: msg.rows });
      } else if (msg.type === "failed") {
        setStatus({ kind: "failed", error: msg.error });
      } else if (msg.type === "goToLine") {
        editorRef.current?.goToLine(msg.line);
      }
    });
    window.oneclientView.postMessage({ type: "hello", windowId });
    return off;
  }, []);

  // Tell Query Results which window is active whenever this one gets focus (core focuses it on tab switch).
  useEffect(() => {
    const onFocus = () => window.oneclientView.postMessage({ type: "activate", windowId, title: windowTitle() });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

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
      if (autorun && initialSql) {
        // Wait briefly for server info so the results status bar can show it.
        await new Promise((r) => setTimeout(r, 150));
        execute({ sql: initialSql, lineOffset: 1 });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  // F5 / Ctrl+Enter / Ctrl+E execute, Alt+Break (or Esc while running) cancel, Ctrl+R show results.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "F5" || (mod && (e.key.toLowerCase() === "e" || e.key === "Enter"))) {
        e.preventDefault();
        execute();
      } else if ((e.altKey && (e.key === "Pause" || e.key === "Cancel")) || (e.key === "Escape" && running)) {
        e.preventDefault();
        cancel();
      } else if (mod && e.key.toLowerCase() === "r") {
        e.preventDefault();
        window.oneclientView.revealView(RESULTS_VIEW);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [execute, cancel, running]);

  const dbOptions = database && !databases.includes(database) ? [database, ...databases] : databases;
  const badge = statusBadge(status, now);

  return (
    <div className="window">
      <div className="toolbar">
        <select
          className="db-select"
          value={database ?? ""}
          onChange={(e) => setDatabase(e.target.value)}
          disabled={running}
          title="Database — switching opens a new session (temp tables and SET options don't carry over)"
        >
          {!database && <option value="">(default)</option>}
          {dbOptions.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button className="btn btn-run" onClick={() => execute()} disabled={running} title="Execute (F5 / Ctrl+Enter) — runs the selection if there is one">
          ▶ Execute
        </button>
        <button className="btn" onClick={cancel} disabled={!running} title="Cancel executing query (Esc)">
          ■ Cancel
        </button>
        <span className="toolbar-sep" />
        <button className="btn" onClick={() => window.oneclientView.revealView(RESULTS_VIEW)} title="Show results (Ctrl+R)">
          ▦ Results
        </button>
        <span className="spacer" />
        {badge && (
          <button className={`run-badge ${badge.tone}`} onClick={() => window.oneclientView.revealView(RESULTS_VIEW)} title="Show results">
            {badge.text}
          </button>
        )}
        <span className="toolbar-info" title={info ? `${info.server} (${info.version}) — ${info.login}` : ""}>
          {info ? `${info.server} · ${info.login}` : ""}
        </span>
      </div>
      <div className="editor-pane">
        <SqlEditor ref={editorRef} value={sql} onChange={setSql} completionProviders={completionProviders} />
      </div>
    </div>
  );
}

function windowTitle(): string {
  return new URLSearchParams(location.search).get("title") ?? document.title ?? "Query";
}

function statusBadge(status: Status, now: number): { text: string; tone: string } | null {
  switch (status.kind) {
    case "idle":
      return null;
    case "running":
      return { text: `● Executing… ${formatElapsed(now - status.started)}`, tone: "running" };
    case "failed":
      return { text: "✗ Query failed", tone: "error" };
    case "done":
      if (status.cancelled) return { text: "■ Cancelled", tone: "warn" };
      return status.hasErrors
        ? { text: `✗ Completed with errors · ${formatElapsed(status.elapsedMs)}`, tone: "error" }
        : { text: `✓ ${status.rows.toLocaleString()} rows · ${formatElapsed(status.elapsedMs)}`, tone: "ok" };
  }
}
