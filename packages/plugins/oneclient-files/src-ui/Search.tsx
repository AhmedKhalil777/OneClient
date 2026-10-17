import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Mirrors the result types in ../src/search.ts (the UI bundle can't import Node-side code).
interface LineMatch {
  line: number;
  col: number;
  length: number;
  text: string;
  textOffset: number;
}
interface FileMatches {
  path: string;
  matches: LineMatch[];
}
interface FindResult {
  files: FileMatches[];
  totalMatches: number;
  filesSearched: number;
  truncated: boolean;
}
type Reply<T> = ({ ok: true } & T) | { ok: false; error: string };

const connectionId = new URLSearchParams(location.search).get("connectionId") ?? "";

async function call<T>(command: string, args: Record<string, unknown>): Promise<Reply<T>> {
  try {
    return (await window.oneclientView.invokeCommand(command, [{ connectionId, ...args }])) as Reply<T>;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** One line of results with the hit highlighted; very long lines are shown around the hit. */
function Preview({ m, replacement }: { m: LineMatch; replacement: string | null }) {
  const start = m.col - 1 - m.textOffset;
  const before = m.text.slice(0, Math.max(0, start)).replace(/^\s+/, "");
  const hit = m.text.slice(Math.max(0, start), Math.max(0, start) + m.length);
  const after = m.text.slice(Math.max(0, start) + m.length);
  return (
    <span className="sr-line">
      {before}
      <mark className={replacement !== null ? "sr-old" : ""}>{hit}</mark>
      {replacement !== null && replacement !== "" && <mark className="sr-new">{replacement}</mark>}
      {after}
    </span>
  );
}

/** "Search" for one open folder — find (and replace) text in its files, VS Code style. */
export function Search() {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [result, setResult] = useState<FindResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [confirmAll, setConfirmAll] = useState(false);
  const [note, setNote] = useState("");
  const run = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const options = useMemo(() => ({ query, caseSensitive, wholeWord, regex, include, exclude }), [query, caseSensitive, wholeWord, regex, include, exclude]);

  const search = useCallback(
    async (opts: typeof options) => {
      const id = ++run.current;
      if (!opts.query) {
        setResult(null);
        setError("");
        setBusy(false);
        return;
      }
      setBusy(true);
      const r = await call<FindResult>("files.find", opts);
      if (run.current !== id) return;
      setBusy(false);
      setDismissed(new Set());
      setCollapsed(new Set());
      setConfirmAll(false);
      if (!r.ok) {
        setError(r.error);
        setResult(null);
      } else {
        setError("");
        setResult(r);
      }
    },
    [],
  );

  useEffect(() => {
    const t = setTimeout(() => void search(options), 350);
    return () => clearTimeout(t);
  }, [options, search]);

  const open = async (path: string, m?: LineMatch) => {
    window.oneclientView.openView({ viewId: "files.editor", title: baseName(path), params: { path } });
    if (m) await call("files.reveal", { path, line: m.line, col: m.col, length: m.length });
  };

  const visible = (result?.files ?? []).filter((f) => !dismissed.has(f.path));
  const visibleMatches = visible.reduce((n, f) => n + f.matches.length, 0);

  const replace = async (paths?: string[]) => {
    setBusy(true);
    const r = await call<{ filesChanged: number; replacements: number; errors: string[] }>("files.replace", { ...options, replacement, ...(paths ? { paths } : { paths: visible.map((f) => f.path) }) });
    setBusy(false);
    setConfirmAll(false);
    if (!r.ok) return setError(r.error);
    setNote(`Replaced ${r.replacements} occurrence${r.replacements === 1 ? "" : "s"} in ${r.filesChanged} file${r.filesChanged === 1 ? "" : "s"}.${r.errors.length ? ` ${r.errors.length} failed: ${r.errors[0]}` : ""}`);
    await search(options);
  };

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  return (
    <div className="sr-page">
      <div className="sr-form">
        <div className="sr-row">
          <button className={`sr-twisty ${showReplace ? "on" : ""}`} title="Toggle Replace" onClick={() => setShowReplace(!showReplace)}>
            {showReplace ? "▾" : "▸"}
          </button>
          <div className="sr-field">
            <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" spellCheck={false} onKeyDown={(e) => e.key === "Enter" && void search(options)} />
            <button className={`sr-toggle ${caseSensitive ? "on" : ""}`} title="Match Case" onClick={() => setCaseSensitive(!caseSensitive)}>
              Aa
            </button>
            <button className={`sr-toggle ${wholeWord ? "on" : ""}`} title="Match Whole Word" onClick={() => setWholeWord(!wholeWord)}>
              <u>ab</u>
            </button>
            <button className={`sr-toggle ${regex ? "on" : ""}`} title="Use Regular Expression" onClick={() => setRegex(!regex)}>
              .*
            </button>
          </div>
        </div>
        {showReplace && (
          <div className="sr-row">
            <span className="sr-twisty" />
            <div className="sr-field">
              <input value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder={regex ? "Replace (use $1 for groups)" : "Replace"} spellCheck={false} />
              <button className="sr-toggle" title="Replace All" disabled={!visibleMatches || busy} onClick={() => setConfirmAll(true)}>
                ⇄
              </button>
            </div>
          </div>
        )}
        <div className="sr-row">
          <button className="sr-link" onClick={() => setShowFilters(!showFilters)}>
            {showFilters ? "▾" : "▸"} files to include / exclude
          </button>
        </div>
        {showFilters && (
          <>
            <div className="sr-row">
              <span className="sr-twisty" />
              <input className="sr-input" value={include} onChange={(e) => setInclude(e.target.value)} placeholder="files to include (e.g. src, **/*.ts)" spellCheck={false} />
            </div>
            <div className="sr-row">
              <span className="sr-twisty" />
              <input className="sr-input" value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="files to exclude (e.g. **/*.test.ts, docs)" spellCheck={false} />
            </div>
          </>
        )}
      </div>

      <div className="sr-status">
        {error ? (
          <span className="sr-error">{error}</span>
        ) : busy ? (
          "Searching…"
        ) : result ? (
          result.totalMatches === 0 ? (
            `No results in ${result.filesSearched} file${result.filesSearched === 1 ? "" : "s"}.`
          ) : (
            `${visibleMatches} result${visibleMatches === 1 ? "" : "s"} in ${visible.length} file${visible.length === 1 ? "" : "s"}${result.truncated ? " — showing the first results; narrow the search" : ""}`
          )
        ) : (
          "Type to search the files of this folder. node_modules, .git and build folders are skipped."
        )}
        {note && <span className="sr-note"> {note}</span>}
      </div>

      {confirmAll && (
        <div className="sr-confirm">
          Replace {visibleMatches} occurrence{visibleMatches === 1 ? "" : "s"} in {visible.length} file{visible.length === 1 ? "" : "s"} with “{replacement}”? This changes the files on disk and cannot be undone.
          <span className="sr-confirm-actions">
            <button className="sr-btn primary" onClick={() => void replace()}>
              Replace
            </button>
            <button className="sr-btn" onClick={() => setConfirmAll(false)}>
              Cancel
            </button>
          </span>
        </div>
      )}

      <div className="sr-results">
        {visible.map((f) => {
          const isCollapsed = collapsed.has(f.path);
          return (
            <Fragment key={f.path}>
              <div className="sr-file" onClick={() => setCollapsed(toggle(collapsed, f.path))}>
                <span className="sr-caret">{isCollapsed ? "▸" : "▾"}</span>
                <span className="sr-name" onDoubleClick={() => void open(f.path)}>
                  {baseName(f.path)}
                </span>
                <span className="sr-dir">{dirName(f.path)}</span>
                <span className="sr-count">{f.matches.length}</span>
                <span className="sr-actions">
                  {showReplace && (
                    <button
                      className="sr-icon"
                      title="Replace in this file"
                      onClick={(e) => {
                        e.stopPropagation();
                        void replace([f.path]);
                      }}
                    >
                      ⇄
                    </button>
                  )}
                  <button
                    className="sr-icon"
                    title="Dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDismissed(toggle(dismissed, f.path));
                    }}
                  >
                    ✕
                  </button>
                </span>
              </div>
              {!isCollapsed &&
                f.matches.map((m, i) => (
                  <div key={i} className="sr-match" onClick={() => void open(f.path, m)} title={`${f.path}:${m.line}`}>
                    <span className="sr-ln">{m.line}</span>
                    <Preview m={m} replacement={showReplace && replacement !== "" && !regex ? replacement : showReplace && replacement !== "" ? replacement : null} />
                  </div>
                ))}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
