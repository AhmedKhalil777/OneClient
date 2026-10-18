import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { WorkspaceFolderInfo } from "../../../shared/ipc-contract.js";
import { ThemeIcon, useResourceIcon } from "../theme.js";
import { AssetIcon } from "./AssetIcon.js";

// Mirrors the find / replace result types in src/main/workspace/search.ts (the renderer can't import main-process code).
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

/** One folder's answer. */
interface FolderResult {
  folder: WorkspaceFolderInfo;
  result?: FindResult;
  error?: string;
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<Reply<T>> {
  try {
    return (await window.oneclient.executeCommand(command, [args])) as Reply<T>;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const joinPath = (root: string, rel: string) => `${root.replace(/[\\/]+$/, "")}${root.includes("\\") ? "\\" : "/"}${rel.split("/").join(root.includes("\\") ? "\\" : "/")}`;
const keyOf = (folder: WorkspaceFolderInfo, path: string) => `${folder.id}:${path}`;

/** One line of results with the hit highlighted (and the replacement, while replacing). */
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

function FileIcon({ name }: { name: string }) {
  const icon = useResourceIcon({ name, kind: "file" });
  return icon ? <AssetIcon pluginId="" icon={icon} size={16} /> : <ThemeIcon id="file" />;
}

export interface SearchViewHandle {
  /** Focus the search box (Ctrl+Shift+F), optionally with the replace row open (Ctrl+Shift+H). */
  focus(opts?: { replace?: boolean }): void;
}

/**
 * The Search sidebar (core): find and replace text across every folder open in the Explorer — VS Code style.
 * The search itself runs in the built-in Explorer extension (`files.find` / `files.replace`) per folder.
 */
export const SearchView = forwardRef<SearchViewHandle, { folders: WorkspaceFolderInfo[]; onOpenExplorer: () => void; onError: (message: string) => void }>(function SearchView(
  { folders, onOpenExplorer, onError },
  ref,
) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [results, setResults] = useState<FolderResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [confirmAll, setConfirmAll] = useState(false);
  const [note, setNote] = useState("");
  const run = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus(opts) {
      if (opts?.replace) setShowReplace(true);
      // A selection-free focus that also selects what's there, like VS Code.
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    },
  }));
  useEffect(() => input.current?.focus(), []);

  const options = useMemo(() => ({ query, caseSensitive, wholeWord, regex, include, exclude }), [query, caseSensitive, wholeWord, regex, include, exclude]);
  const folderKey = folders.map((f) => f.id).join(",");

  const search = useCallback(
    async (opts: typeof options) => {
      const id = ++run.current;
      if (!opts.query || folders.length === 0) {
        setResults(null);
        setBusy(false);
        return;
      }
      setBusy(true);
      const all = await Promise.all(
        folders.map(async (folder): Promise<FolderResult> => {
          const r = await call<FindResult>("files.find", { connectionId: folder.id, ...opts });
          return r.ok ? { folder, result: r } : { folder, error: r.error };
        }),
      );
      if (run.current !== id) return;
      setBusy(false);
      setDismissed(new Set());
      setCollapsed(new Set());
      setConfirmAll(false);
      setResults(all);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folderKey],
  );

  useEffect(() => {
    const t = setTimeout(() => void search(options), 300);
    return () => clearTimeout(t);
  }, [options, search]);

  const open = (folder: WorkspaceFolderInfo, path: string, m?: LineMatch) => {
    window.oneclient
      .openWorkspaceFile(joinPath(folder.path, path), m ? { line: m.line, column: m.col, length: m.length } : {})
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
  };

  const visible = (results ?? []).map((r) => ({ ...r, files: (r.result?.files ?? []).filter((f) => !dismissed.has(keyOf(r.folder, f.path))) }));
  const visibleFiles = visible.reduce((n, r) => n + r.files.length, 0);
  const visibleMatches = visible.reduce((n, r) => n + r.files.reduce((k, f) => k + f.matches.length, 0), 0);
  const errors = (results ?? []).filter((r) => r.error);
  const truncated = (results ?? []).some((r) => r.result?.truncated);
  const searched = (results ?? []).reduce((n, r) => n + (r.result?.filesSearched ?? 0), 0);

  const replace = async (only?: { folder: WorkspaceFolderInfo; path: string }) => {
    setBusy(true);
    let files = 0;
    let count = 0;
    const failures: string[] = [];
    for (const r of visible) {
      if (only && only.folder.id !== r.folder.id) continue;
      const paths = only ? [only.path] : r.files.map((f) => f.path);
      if (!paths.length) continue;
      const res = await call<{ filesChanged: number; replacements: number; errors: string[] }>("files.replace", { connectionId: r.folder.id, ...options, replacement, paths });
      if (!res.ok) failures.push(`${r.folder.name}: ${res.error}`);
      else {
        files += res.filesChanged;
        count += res.replacements;
        failures.push(...res.errors);
      }
    }
    setBusy(false);
    setConfirmAll(false);
    setNote(`Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}.${failures.length ? ` ${failures.length} failed: ${failures[0]}` : ""}`);
    await search(options);
  };

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const collapseAll = () => setCollapsed(new Set(visible.flatMap((r) => r.files.map((f) => keyOf(r.folder, f.path)))));
  const clear = () => {
    setQuery("");
    setReplacement("");
    setResults(null);
    setNote("");
    input.current?.focus();
  };

  return (
    <div className="sidebar search-view">
      <div className="sidebar-header">
        <span>SEARCH</span>
        <span className="sidebar-header-actions">
          <button className="icon-button" title="Refresh" disabled={!query} onClick={() => void search(options)}>
            <ThemeIcon id="refresh" />
          </button>
          <button className="icon-button" title="Clear Search Results" disabled={!query && !results} onClick={clear}>
            <ThemeIcon id="clear-all" />
          </button>
          <button className="icon-button" title="Collapse All" disabled={!visibleFiles} onClick={collapseAll}>
            <ThemeIcon id="collapse-all" />
          </button>
        </span>
      </div>

      {folders.length === 0 ? (
        <div className="empty-hint">
          Search looks inside the folders open in the Explorer.{" "}
          <button className="link-button" onClick={onOpenExplorer}>
            Open a folder
          </button>
        </div>
      ) : (
        <>
          <div className="sr-form">
            <div className="sr-row">
              <button className={`sr-twisty ${showReplace ? "on" : ""}`} title="Toggle Replace (Ctrl+Shift+H)" onClick={() => setShowReplace(!showReplace)}>
                <ThemeIcon id={showReplace ? "chevron-down" : "chevron-right"} size={14} />
              </button>
              <div className="sr-field">
                <input
                  ref={input}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search"
                  spellCheck={false}
                  onKeyDown={(e) => e.key === "Enter" && void search(options)}
                />
                <button className={`sr-toggle ${caseSensitive ? "on" : ""}`} title="Match Case (Alt+C)" onClick={() => setCaseSensitive(!caseSensitive)}>
                  Aa
                </button>
                <button className={`sr-toggle ${wholeWord ? "on" : ""}`} title="Match Whole Word (Alt+W)" onClick={() => setWholeWord(!wholeWord)}>
                  <u>ab</u>
                </button>
                <button className={`sr-toggle ${regex ? "on" : ""}`} title="Use Regular Expression (Alt+R)" onClick={() => setRegex(!regex)}>
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
                    <ThemeIcon id="replace-all" size={14} />
                  </button>
                </div>
              </div>
            )}
            <div className="sr-row">
              <span className="sr-twisty" />
              <button className="sr-link" onClick={() => setShowFilters(!showFilters)} title="Toggle Search Details">
                ⋯ files to include / exclude
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
            {busy ? (
              "Searching…"
            ) : results ? (
              visibleMatches === 0 && errors.length === 0 ? (
                `No results in ${searched} file${searched === 1 ? "" : "s"}.`
              ) : (
                `${visibleMatches} result${visibleMatches === 1 ? "" : "s"} in ${visibleFiles} file${visibleFiles === 1 ? "" : "s"}${truncated ? " — showing the first results; narrow the search" : ""}`
              )
            ) : (
              `Searches ${folders.length === 1 ? `“${folders[0]!.name}”` : `${folders.length} folders`}. node_modules, .git and build folders are skipped.`
            )}
            {errors.map((r) => (
              <div key={r.folder.id} className="sr-error">
                {folders.length > 1 ? `${r.folder.name}: ` : ""}
                {r.error}
              </div>
            ))}
            {note && <div className="sr-note">{note}</div>}
          </div>

          {confirmAll && (
            <div className="sr-confirm">
              Replace {visibleMatches} occurrence{visibleMatches === 1 ? "" : "s"} in {visibleFiles} file{visibleFiles === 1 ? "" : "s"} with “{replacement}”? This changes the files on disk.
              <span className="sr-confirm-actions">
                <button className="btn btn-primary" onClick={() => void replace()}>
                  Replace
                </button>
                <button className="btn" onClick={() => setConfirmAll(false)}>
                  Cancel
                </button>
              </span>
            </div>
          )}

          <div className="sr-results">
            {visible.map((r) => (
              <Fragment key={r.folder.id}>
                {folders.length > 1 && r.files.length > 0 && (
                  <div className="sr-folder" title={r.folder.path}>
                    <ThemeIcon id="folder" size={14} /> {r.folder.name}
                  </div>
                )}
                {r.files.map((f) => {
                  const key = keyOf(r.folder, f.path);
                  const isCollapsed = collapsed.has(key);
                  return (
                    <Fragment key={key}>
                      <div className="sr-file" onClick={() => setCollapsed(toggle(collapsed, key))} title={joinPath(r.folder.path, f.path)}>
                        <ThemeIcon id={isCollapsed ? "chevron-right" : "chevron-down"} size={14} />
                        <FileIcon name={baseName(f.path)} />
                        <span className="sr-name" onDoubleClick={() => open(r.folder, f.path)}>
                          {baseName(f.path)}
                        </span>
                        <span className="sr-dir">{dirName(f.path)}</span>
                        <span className="sr-count">{f.matches.length}</span>
                        <span className="sr-actions">
                          {showReplace && (
                            <button
                              className="icon-button"
                              title="Replace in this file"
                              onClick={(e) => {
                                e.stopPropagation();
                                void replace({ folder: r.folder, path: f.path });
                              }}
                            >
                              <ThemeIcon id="replace-all" size={14} />
                            </button>
                          )}
                          <button
                            className="icon-button"
                            title="Dismiss"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDismissed(toggle(dismissed, key));
                            }}
                          >
                            <ThemeIcon id="close" size={14} />
                          </button>
                        </span>
                      </div>
                      {!isCollapsed &&
                        f.matches.map((m, i) => (
                          <div key={i} className="sr-match" onClick={() => open(r.folder, f.path, m)} title={`${f.path}:${m.line}`}>
                            <Preview m={m} replacement={showReplace && replacement !== "" ? replacement : null} />
                          </div>
                        ))}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </>
      )}
    </div>
  );
});
