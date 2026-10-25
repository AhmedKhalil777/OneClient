import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { layoutGraph, type GraphRow } from "@oneclient/backend/shared/git-graph.js";
import type { Change, Commit, RepoState } from "@oneclient/backend/shared/ipc-contract.js";

const ROW_H = 26;
const LANE_W = 14;
const MAX_GRAPH_W = 220;
const LANE_COLORS = ["#4fa3ff", "#e5b847", "#c77dff", "#3fc28c", "#ff7a7a", "#57d0e0", "#f08bd0", "#b5cc57"];
const laneX = (lane: number) => 10 + lane * LANE_W;

const call = <T,>(id: string, args: Record<string, unknown> = {}) => window.oneclientView.invokeCommand(id, [args]) as Promise<T>;

function ago(epochSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const hue = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function Lanes({ row, head, width }: { row: GraphRow; head: boolean; width: number }) {
  const mid = ROW_H / 2;
  const path = (x1: number, y1: number, x2: number, y2: number) => (x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`);
  const color = (i: number) => LANE_COLORS[i % LANE_COLORS.length]!;
  return (
    <svg width={width} height={ROW_H} aria-hidden>
      {row.top.map((s, i) => <path key={`t${i}`} d={path(laneX(s.from), 0, laneX(s.to), mid)} stroke={color(s.color)} fill="none" strokeWidth={2} />)}
      {row.bottom.map((s, i) => <path key={`b${i}`} d={path(laneX(s.from), mid, laneX(s.to), ROW_H)} stroke={color(s.color)} fill="none" strokeWidth={2} />)}
      <circle cx={laneX(row.lane)} cy={mid} r={head ? 5.5 : 4.5} fill={head ? "var(--oc-editor-background, #1e1e1e)" : color(row.color)} stroke={color(row.color)} strokeWidth={2} />
    </svg>
  );
}

function Refs({ refs }: { refs: string[] }) {
  return (
    <>
      {refs.map((r) => {
        const head = r.startsWith("HEAD -> ");
        const name = head ? r.slice(8) : r;
        const kind = name.startsWith("tag: ") ? "tag" : head || r === "HEAD" ? "head" : name.includes("/") ? "remote" : "local";
        return (
          <span key={r} className={`g-ref ${kind}`} title={r}>
            {kind === "tag" ? name.slice(5) : name}
          </span>
        );
      })}
    </>
  );
}

/**
 * The Git Graph tab (core view "git.graph"): the whole history of a repository as a wide, searchable table with
 * branch lanes, refs, authors and dates; pick a commit to see its message and changed files and open any file's diff.
 */
export function GraphView() {
  const [repos, setRepos] = useState<RepoState[] | null>(null);
  const [root, setRoot] = useState(() => localStorage.getItem("oneclient.graph.repo") ?? "");
  const [all, setAll] = useState(() => localStorage.getItem("oneclient.graph.all") !== "0");
  const [commits, setCommits] = useState<Commit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<Change[] | null>(null);
  const [body, setBody] = useState<string>("");
  const [query, setQuery] = useState("");
  const [matchAt, setMatchAt] = useState(0);
  const [confirmRef, setConfirmRef] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const scroller = useRef<HTMLDivElement>(null);
  const detailsFor = useRef("");

  const repo = repos?.find((r) => r.root === root) ?? repos?.[0];

  // The repositories of the open folders, refreshed while the tab is open (HEAD moves when you commit elsewhere).
  useEffect(() => {
    let live = true;
    const poll = () => void call<RepoState[]>("git.repos").then((r) => live && setRepos(r)).catch((e: unknown) => live && setError(String(e)));
    poll();
    const t = window.setInterval(poll, 5000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);

  const stamp = repo ? `${repo.root}|${repo.headSha}|${repo.ahead}|${repo.behind}|${all}` : "";
  const load = useCallback(() => {
    if (!repo) return;
    setLoading(true);
    void call<Commit[]>("git.log", { root: repo.root, all, limit: 3000 })
      .then((list) => {
        setCommits(list);
        setError("");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [repo?.root, all]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [stamp, load]);

  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const lanes = useMemo(() => rows.reduce((w, r) => Math.max(w, r.width), 1), [rows]);
  const graphW = Math.max(64, Math.min(MAX_GRAPH_W, laneX(lanes - 1) + 12));

  // Search: matching rows are highlighted; Enter / Shift+Enter walk through them.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as number[];
    const out: number[] = [];
    commits.forEach((c, i) => {
      if (c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.sha.startsWith(q) || c.refs.some((r) => r.toLowerCase().includes(q))) out.push(i);
    });
    return out;
  }, [commits, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);

  const scrollTo = (index: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = index * ROW_H;
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - ROW_H * 2) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
  };
  const gotoMatch = (delta: number) => {
    if (!matches.length) return;
    const next = (matchAt + delta + matches.length) % matches.length;
    setMatchAt(next);
    setSelected(commits[matches[next]!]!.sha);
    scrollTo(matches[next]!);
  };
  useEffect(() => {
    setMatchAt(0);
    if (matches.length) scrollTo(matches[0]!);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Details of the selected commit.
  const commit = commits.find((c) => c.sha === selected);
  useEffect(() => {
    if (!commit || !repo) return;
    detailsFor.current = commit.sha;
    setFiles(null);
    setBody("");
    setConfirmRef(null);
    void call<Change[]>("git.commitFiles", { root: repo.root, sha: commit.sha }).then((f) => detailsFor.current === commit.sha && setFiles(f));
    void call<{ body: string }>("git.commitDetails", { root: repo.root, sha: commit.sha }).then((d) => detailsFor.current === commit.sha && setBody(d.body));
  }, [commit?.sha, repo?.root]); // eslint-disable-line react-hooks/exhaustive-deps

  // Virtual scrolling: only the rows in view (plus a margin) exist in the DOM.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setViewport({ top: el.scrollTop, height: el.clientHeight });
    };
    const onScroll = () => frame || (frame = requestAnimationFrame(update));
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [repo?.root, commits.length]);

  const first = Math.max(0, Math.floor(viewport.top / ROW_H) - 8);
  const last = Math.min(commits.length, Math.ceil((viewport.top + viewport.height) / ROW_H) + 8);

  const flash = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 2200);
  };
  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => flash("Copied"));

  const openDiff = (c: Commit, f: Change) => {
    if (!repo) return;
    const parent = c.parents[0];
    window.oneclientView.openView({
      viewId: "git.diff",
      title: `${baseName(f.path)} (${c.sha.slice(0, 7)})`,
      params: { root: repo.root, path: f.path, left: f.status === "A" || !parent ? "empty" : `${c.sha}^`, right: f.status === "D" ? "empty" : c.sha, ...(f.origPath ? { origPath: f.origPath } : {}) },
    });
  };

  const checkout = (name: string) => {
    if (!repo) return;
    void call("git.checkoutRef", { root: repo.root, name })
      .then(() => (flash(`Checked out ${name}`), setConfirmRef(null)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = Math.max(0, commits.findIndex((c) => c.sha === selected));
    const next = Math.min(commits.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
    if (commits[next]) {
      setSelected(commits[next]!.sha);
      scrollTo(next);
    }
  };

  if (repos === null) return <div className="g-empty">Loading…</div>;
  if (repos.length === 0) return <div className="g-empty"><h3>No Git repository</h3><p>Open a folder that is a Git repository (File ▸ Open Folder) and its history shows up here.</p></div>;

  const parents = commit ? commit.parents.map((p) => p.slice(0, 7)) : [];
  const branchRefs = commit ? commit.refs.map((r) => (r.startsWith("HEAD -> ") ? r.slice(8) : r)).filter((r) => r !== "HEAD" && !r.startsWith("tag: ")) : [];

  return (
    <div className="g-root" tabIndex={0} onKeyDown={onKey}>
      <div className="g-toolbar">
        {repos.length > 1 && (
          <select value={repo?.root} onChange={(e) => (localStorage.setItem("oneclient.graph.repo", e.target.value), setRoot(e.target.value))} title="Repository">
            {repos.map((r) => <option key={r.root} value={r.root}>{r.name}</option>)}
          </select>
        )}
        {repos.length === 1 && <span className="g-repo">{repo?.name}</span>}
        {repo && <span className="g-branch" title="Current branch">{repo.branch ?? "(detached HEAD)"}{repo.ahead ? ` ↑${repo.ahead}` : ""}{repo.behind ? ` ↓${repo.behind}` : ""}</span>}
        <label className="g-toggle" title="Show every branch, or only the current one and its upstream">
          <input type="checkbox" checked={all} onChange={(e) => (localStorage.setItem("oneclient.graph.all", e.target.checked ? "1" : "0"), setAll(e.target.checked))} /> All branches
        </label>
        <span className="g-spacer" />
        <input
          className="g-search"
          placeholder="Search message, author, hash or branch…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), gotoMatch(e.shiftKey ? -1 : 1))}
        />
        {query && <span className="g-count">{matches.length ? `${matchAt + 1} / ${matches.length}` : "no match"}</span>}
        <button className="g-btn" title="Fetch from the remote" onClick={() => repo && void call("git.fetchRepo", { root: repo.root }).then(() => flash("Fetched")).catch((e: unknown) => setError(String(e)))}>Fetch</button>
        <button className="g-btn" title="Reload" onClick={load}>{loading ? "…" : "Refresh"}</button>
      </div>

      {error && <div className="g-error" onClick={() => setError("")}>{error}</div>}
      {notice && <div className="g-toast">{notice}</div>}

      <div className="g-table">
        <div className="g-head" style={{ gridTemplateColumns: `${graphW}px minmax(200px, 1fr) 130px 150px 80px` }}>
          <span>Graph</span>
          <span>Description</span>
          <span>Date</span>
          <span>Author</span>
          <span>Commit</span>
        </div>
        <div className="g-scroll" ref={scroller}>
          {commits.length === 0 && !loading && <div className="g-empty small">No commits yet.</div>}
          <div style={{ height: commits.length * ROW_H, position: "relative" }}>
            <div style={{ transform: `translateY(${first * ROW_H}px)` }}>
              {commits.slice(first, last).map((c, k) => {
                const i = first + k;
                const head = c.sha === repo?.headSha;
                return (
                  <div
                    key={c.sha}
                    className={`g-row${c.sha === selected ? " sel" : ""}${matchSet.has(i) ? " hit" : ""}${head ? " head" : ""}`}
                    style={{ gridTemplateColumns: `${graphW}px minmax(200px, 1fr) 130px 150px 80px`, height: ROW_H }}
                    onClick={() => setSelected(c.sha === selected ? null : c.sha)}
                  >
                    <span className="g-lanes"><Lanes row={rows[i]!} head={head} width={graphW} /></span>
                    <span className="g-desc"><Refs refs={c.refs} /><span className="g-subject" title={c.subject}>{c.subject}</span></span>
                    <span className="g-date" title={new Date(c.date * 1000).toLocaleString()}>{ago(c.date)}</span>
                    <span className="g-author" title={`${c.author} <${c.email}>`}><i style={{ background: `hsl(${hue(c.email || c.author)} 45% 42%)` }}>{initials(c.author)}</i>{c.author}</span>
                    <span className="g-sha">{c.sha.slice(0, 7)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {commit && (
        <div className="g-details">
          <div className="g-details-head">
            <b>{commit.subject}</b>
            <span className="g-spacer" />
            <button className="g-btn" onClick={() => copy(commit.sha)} title={commit.sha}>Copy hash</button>
            <button className="g-btn" onClick={() => setSelected(null)} title="Close">✕</button>
          </div>
          <div className="g-meta">
            <code>{commit.sha.slice(0, 10)}</code> · {commit.author} &lt;{commit.email}&gt; · {new Date(commit.date * 1000).toLocaleString()}
            {parents.length > 0 && <> · parent{parents.length > 1 ? "s" : ""} {parents.map((p, i) => <button key={p} className="g-link" onClick={() => { const t = commits.findIndex((c) => c.sha.startsWith(p)); if (t >= 0) { setSelected(commits[t]!.sha); scrollTo(t); } }}>{p}{i < parents.length - 1 ? "," : ""}</button>)}</>}
          </div>
          {branchRefs.length > 0 && (
            <div className="g-checkouts">
              {branchRefs.map((r) => (
                <button key={r} className="g-btn small" onClick={() => (confirmRef === r ? checkout(r.replace(/^origin\//, "")) : setConfirmRef(r))} title="Switch the working tree to this branch">
                  {confirmRef === r ? `Click again to check out ${r}` : `Checkout ${r}`}
                </button>
              ))}
            </div>
          )}
          {body && body.trim() !== commit.subject && <pre className="g-body">{body}</pre>}
          <div className="g-files">
            {!files && <div className="g-note">Loading files…</div>}
            {files?.length === 0 && <div className="g-note">No file changes (merge or empty commit).</div>}
            {files?.map((f) => (
              <div key={f.path} className={`g-file st-${f.status}`} onClick={() => openDiff(commit, f)} title={`Open the diff of ${f.path}`}>
                <span className="g-status">{f.status}</span>
                <span className="g-fname">{baseName(f.path)}</span>
                <span className="g-fdir">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
