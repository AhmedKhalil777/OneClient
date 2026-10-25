import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HistoryPanel, type RiskyStatement, SafeModeDialog, findRiskyStatements } from "@oneclient/editor-kit/sql";
import { type ServerInfo, autorun, createSqlApi, initialDatabase, initialFastQuery, initialSql, openHistory, windowId } from "./api.js";
import { type SqlDialectUi, resolveFeatures } from "./dialect.js";
import { formatElapsed } from "./format.js";
import type { ToQueryWindow } from "./protocol.js";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor.js";

type Status =
  | { kind: "idle" }
  | { kind: "running"; started: number; queryId: string }
  | { kind: "done"; hasErrors: boolean; cancelled: boolean; elapsedMs: number; rows: number }
  | { kind: "failed"; error: string };

type FastQuery = { file: string; name: string; anyDatabase: boolean };

const SAFE_MODE_KEY = "oneclient.sql.safeMode";

function initialSafeMode(): boolean {
  try {
    return localStorage.getItem(SAFE_MODE_KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * One query window: toolbar + editor. Results and messages show in the app's shared bottom panel
 * ("Query Results"), not inside this tab — the backend streams them there and tells this window when the run is done.
 * A window opened from FAST TOOLS edits that fast query: ★ Save (Ctrl+S) writes it back.
 */
export function QueryWindow({ dialect }: { dialect: SqlDialectUi }) {
  const api = useMemo(() => createSqlApi(dialect.prefix), [dialect.prefix]);
  const resultsView = `${dialect.prefix}.results`;
  const [sql, setSql] = useState(initialSql);
  const [database, setDatabase] = useState<string | undefined>(initialDatabase);
  const [databases, setDatabases] = useState<string[]>([]);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [now, setNow] = useState(Date.now());
  const [showHistory, setShowHistory] = useState(openHistory && resolveFeatures(dialect).history);
  const [historyToken, setHistoryToken] = useState(0);
  const [safeMode, setSafeMode] = useState(initialSafeMode);
  const [pending, setPending] = useState<{ risks: RiskyStatement[]; runnable: { sql: string; lineOffset: number } } | null>(null);
  const [fastQuery, setFastQuery] = useState<FastQuery | null>(initialFastQuery);
  const [savedSql, setSavedSql] = useState(initialFastQuery ? initialSql : null);
  const [saveDialog, setSaveDialog] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const editorRef = useRef<SqlEditorHandle>(null);

  const databaseRef = useRef(database);
  databaseRef.current = database;
  const infoRef = useRef(info);
  infoRef.current = info;
  const completion = useMemo(() => dialect.createCompletion(() => databaseRef.current), [dialect]);
  const completionProviders = useMemo(() => [completion.provider], [completion]);

  const running = status.kind === "running";
  const features = resolveFeatures(dialect);
  const fastQueries = features.fastQueries;

  const execute = useCallback(
    (override?: { sql: string; lineOffset: number }, confirmed = false) => {
      if (status.kind === "running") return;
      const runnable = override ?? editorRef.current?.getRunnable() ?? { sql, lineOffset: 1 };
      if (!runnable.sql.trim()) return;
      if (features.safeMode && safeMode && !confirmed) {
        const risks = findRiskyStatements(runnable.sql);
        if (risks.length) {
          setPending({ risks, runnable: { sql: runnable.sql, lineOffset: runnable.lineOffset } });
          return;
        }
      }
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
      window.oneclientView.revealView(resultsView);
      // The script may create/alter/drop objects — refresh IntelliSense lazily.
      if (dialect.schemaChange.test(runnable.sql)) completion.invalidate();
    },
    [status.kind, sql, completion, safeMode, features.safeMode, dialect, resultsView],
  );

  const openPlan = useCallback(() => {
    const runnable = editorRef.current?.getRunnable() ?? { sql, lineOffset: 1 };
    if (!runnable.sql.trim()) return;
    window.oneclientView.openView({ viewId: `${dialect.prefix}.plan`, title: "Execution Plan", icon: "$(diagram)", params: { sql: runnable.sql.slice(0, 20000), ...(databaseRef.current ? { database: databaseRef.current } : {}), mode: "estimated" } });
  }, [dialect.prefix, sql]);

  const cancel = useCallback(() => {
    if (status.kind === "running") void api.cancelQuery(status.queryId);
  }, [status, api]);

  /** Writes the fast query (a new one, or the one this window edits) to the connection's Fast Tools folder. */
  const saveFastQuery = useCallback(
    async (target: { name: string; anyDatabase: boolean; file?: string | undefined }) => {
      const r = await api.saveFastQuery({ file: target.file, name: target.name, sql, database: target.anyDatabase ? undefined : databaseRef.current });
      if (!r.ok) {
        setNotice({ text: r.error, tone: "error" });
        return false;
      }
      setFastQuery({ file: r.file, name: r.name, anyDatabase: target.anyDatabase });
      setSavedSql(sql);
      setNotice({ text: `Saved fast query "${r.name}" (${r.file}).`, tone: "ok" });
      window.oneclientView.refreshExplorer();
      return true;
    },
    [api, sql],
  );

  const save = useCallback(() => {
    if (!fastQueries) return;
    if (fastQuery) void saveFastQuery(fastQuery);
    else setSaveDialog(true);
  }, [fastQueries, fastQuery, saveFastQuery]);

  // Unsaved edits of a fast query: ● on the tab, and core asks before closing it.
  useEffect(() => {
    if (savedSql !== null) window.oneclientView.setDirty(sql !== savedSql);
  }, [sql, savedSql]);

  useEffect(() => {
    if (!notice || notice.tone === "error") return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // Backend → this window (filter: every window of the connection gets these).
  useEffect(() => {
    const off = window.oneclientView.onMessage((raw) => {
      const msg = raw as ToQueryWindow;
      if (msg.windowId !== windowId) return;
      if (msg.type === "done") {
        if (msg.database) setDatabase(msg.database);
        setStatus({ kind: "done", hasErrors: msg.hasErrors, cancelled: msg.cancelled, elapsedMs: msg.elapsedMs, rows: msg.rows });
        setHistoryToken((n) => n + 1);
      } else if (msg.type === "failed") {
        setStatus({ kind: "failed", error: msg.error });
        setHistoryToken((n) => n + 1);
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

  // Initial load: server info, database list, the session's current database, then autorun (Select Top 1000, a fast query).
  useEffect(() => {
    void api.serverInfo().then(setInfo).catch(() => undefined);
    void api.listDatabases().then(setDatabases).catch(() => undefined);
    void (async () => {
      if (!initialDatabase) {
        // An empty run just opens this window's session and reports the current database.
        const r = await api.executeQuery({ queryId: "init", sql: "" }).catch(() => null);
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

  // F5 / Ctrl+E (and Ctrl+Enter where the dialect wants it) execute, Alt+Break (or Esc while running) cancel,
  // Ctrl+R show results, Ctrl+Shift+H history, Ctrl+S save as fast query.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "F5" || (mod && (e.key.toLowerCase() === "e" || (dialect.ctrlEnterExecutes && e.key === "Enter")))) {
        e.preventDefault();
        execute();
      } else if ((e.altKey && (e.key === "Pause" || e.key === "Cancel")) || (e.key === "Escape" && running)) {
        e.preventDefault();
        cancel();
      } else if (features.history && mod && e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setShowHistory((v) => !v);
      } else if (features.plan && mod && !e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        openPlan();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      } else if (mod && e.key.toLowerCase() === "r") {
        e.preventDefault();
        window.oneclientView.revealView(resultsView);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [execute, cancel, save, openPlan, running, dialect, resultsView, features.history, features.plan]);

  function toggleSafeMode(on: boolean) {
    setSafeMode(on);
    try {
      localStorage.setItem(SAFE_MODE_KEY, on ? "on" : "off");
    } catch {
      // not remembered
    }
  }

  const dbOptions = database && !databases.includes(database) ? [database, ...databases] : databases;
  const badge = statusBadge(status, now);

  return (
    <div className="window">
      <div className="toolbar">
        <select className="db-select" value={database ?? ""} onChange={(e) => setDatabase(e.target.value)} disabled={running} title={dialect.databaseTitle ?? "Available databases"}>
          {!database && <option value="">(default)</option>}
          {dbOptions.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button className="btn btn-run" onClick={() => execute()} disabled={running} title={`Execute (F5${dialect.ctrlEnterExecutes ? " / Ctrl+Enter" : ""}) — runs the selection if there is one`}>
          ▶ Execute
        </button>
        <button className="btn" onClick={cancel} disabled={!running} title={dialect.cancelTitle ?? "Cancel executing query (Alt+Break)"}>
          ■ Cancel
        </button>
        <span className="toolbar-sep" />
        <button className="btn" onClick={() => window.oneclientView.revealView(resultsView)} title="Show results (Ctrl+R)">
          ▦ Results
        </button>
        {features.history && (
          <button className={`btn ${showHistory ? "btn-on" : ""}`} onClick={() => setShowHistory((v) => !v)} title="Query history of this connection (Ctrl+Shift+H)">
            ⟲ History
          </button>
        )}
        {features.plan && (
          <button className="btn" onClick={openPlan} title="Show the execution plan of the selection (or the script) — Ctrl+L. Nothing runs; the Actual plan can be chosen in the plan tab.">
            ▤ Plan
          </button>
        )}
        {fastQueries && (
          <button
            className="btn"
            onClick={save}
            disabled={!sql.trim()}
            title={fastQuery ? `Save "${fastQuery.name}" (${fastQuery.file}) — Ctrl+S` : "Save this script as a fast query in FAST TOOLS, to run again in one click (Ctrl+S)"}
          >
            ★ {fastQuery ? "Save Fast Query" : "Save as Fast Query"}
          </button>
        )}
        {features.safeMode && (
          <label className="safe-toggle" title="Safe mode: ask before UPDATE/DELETE without WHERE, DROP, TRUNCATE">
            <input type="checkbox" checked={safeMode} onChange={(e) => toggleSafeMode(e.target.checked)} />
            Safe mode
          </label>
        )}
        <span className="spacer" />
        {notice && (
          <span className={`toolbar-notice ${notice.tone}`} title={notice.text} onClick={() => setNotice(null)}>
            {notice.text}
          </span>
        )}
        {badge && (
          <button className={`run-badge ${badge.tone}`} onClick={() => window.oneclientView.revealView(resultsView)} title="Show results">
            {badge.text}
          </button>
        )}
        <span className="toolbar-info" title={info ? `${info.server} (${info.version}) — ${info.login}` : ""}>
          {info ? `${info.server} · ${info.login}` : ""}
        </span>
      </div>
      <div className="window-body">
        <div className="editor-pane">
          <SqlEditor ref={editorRef} value={sql} onChange={setSql} highlight={dialect.highlight} completionProviders={completionProviders} />
        </div>
        {features.history && showHistory && (
          <HistoryPanel
            load={api.queryHistory}
            remove={api.deleteHistory}
            refreshToken={historyToken}
            onClose={() => (setShowHistory(false), editorRef.current?.focus())}
            onUse={(text, mode) => (mode === "insert" ? editorRef.current?.insertText(text) : (setSql(text), editorRef.current?.focus()))}
            onRun={(text) => {
              setSql(text);
              execute({ sql: text, lineOffset: 1 });
            }}
          />
        )}
      </div>
      {pending && (
        <SafeModeDialog
          risks={pending.risks}
          onCancel={() => (setPending(null), editorRef.current?.focus())}
          onRun={() => {
            const { runnable } = pending;
            setPending(null);
            execute(runnable, true);
          }}
          onDisable={() => {
            const { runnable } = pending;
            toggleSafeMode(false);
            setPending(null);
            execute(runnable, true);
          }}
        />
      )}
      {saveDialog && (
        <SaveFastQueryDialog
          database={database}
          onCancel={() => (setSaveDialog(false), editorRef.current?.focus())}
          onSave={async (name, anyDatabase) => {
            if (await saveFastQuery({ name, anyDatabase })) {
              setSaveDialog(false);
              editorRef.current?.focus();
            }
          }}
        />
      )}
    </div>
  );
}

function SaveFastQueryDialog({ database, onSave, onCancel }: { database: string | undefined; onSave: (name: string, anyDatabase: boolean) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [anyDatabase, setAnyDatabase] = useState(!database);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    await onSave(name.trim(), anyDatabase);
    setBusy(false);
  }

  return (
    <div className="sqlg-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}>
      <form
        className="sqlg-dialog fq-dialog"
        role="dialog"
        aria-labelledby="fq-title"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="sqlg-dialog-title" id="fq-title">
          ★ Save as Fast Query
        </div>
        <label className="fq-field">
          Name
          <input ref={inputRef} className="fq-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Blocking sessions" />
        </label>
        <label className="fq-check">
          <input type="radio" name="fq-scope" checked={!anyDatabase} disabled={!database} onChange={() => setAnyDatabase(false)} />
          Only for <strong>{database ?? "(no database)"}</strong> — listed under it, runs there in one click
        </label>
        <label className="fq-check">
          <input type="radio" name="fq-scope" checked={anyDatabase} onChange={() => setAnyDatabase(true)} />
          Any database — choose where to run it each time
        </label>
        <div className="sqlg-dialog-note">Saved as a plain <code>.query.sql</code> file in the connection's Fast Tools folder, so it can live in a repo.</div>
        <div className="sqlg-dialog-actions">
          <span className="sqlg-spacer" />
          <button type="button" className="sqlg-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="sqlg-btn on" disabled={!name.trim() || busy}>
            Save
          </button>
        </div>
      </form>
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
