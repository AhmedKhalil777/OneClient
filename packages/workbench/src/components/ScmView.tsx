import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Change, Commit, RepoState, WorkspaceFolderInfo } from "@oneclient/backend/shared/ipc-contract.js";
import { type GraphRow, layoutGraph } from "@oneclient/backend/shared/git-graph.js";
import { ThemeIcon, useResourceIcon } from "../theme.js";
import { AssetIcon } from "./AssetIcon.js";
import type { ContextMenuItem } from "./ContextMenu.js";

/** Which comparison a change opens: staged changes compare HEAD↔index, the rest index↔working tree. */
export type ChangeGroup = "merge" | "staged" | "changes";

export interface ScmActions {
  /** Runs a git operation; errors are shown by the caller (and rethrown). */
  git(method: Parameters<typeof window.oneclient.git>[0], ...args: unknown[]): Promise<unknown>;
  openDiff(repo: RepoState, path: string, left: string, right: string, title: string, origPath?: string): void;
  openFile(repo: RepoState, path: string): void;
  pickBranch(repo: RepoState): void;
  menu(e: React.MouseEvent | { clientX: number; clientY: number }, items: ContextMenuItem[]): void;
  confirm(title: string, message: string, label: string): Promise<boolean>;
  createBranch(repo: RepoState): void;
  openFolder(): void;
  /** The repository the user is working in (graph, status bar). */
  activeRoot: string | undefined;
  setActive(root: string): void;
}

const STATUS_LABEL: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Conflict", "?": "Untracked" };
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const relTime = (sec: number) => {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} d ago`;
  return new Date(sec * 1000).toLocaleDateString();
};

/** The sides to compare for a change in a group. */
export function diffSidesFor(repo: RepoState, c: Change, group: ChangeGroup): { left: string; right: string; label: string } {
  if (group === "staged") return { left: c.status === "A" || !repo.headSha ? "empty" : "HEAD", right: c.status === "D" ? "empty" : "index", label: "Index" };
  return { left: "index", right: c.status === "D" ? "empty" : "worktree", label: "Working Tree" };
}

/**
 * Source Control (core), like VS Code's: per repository a commit box, the Merge / Staged / Changes groups with
 * stage, unstage, discard and diff, and the commit Graph. Branch, sync and the rest live in the "…" menus and the
 * status bar.
 */
export function ScmView({ repos, folders, actions }: { repos: RepoState[]; folders: WorkspaceFolderInfo[]; actions: ScmActions }) {
  const [graphOpen, setGraphOpen] = useState(() => localStorage.getItem("oneclient.scm.graph") !== "0");
  const toggleGraph = () => {
    localStorage.setItem("oneclient.scm.graph", graphOpen ? "0" : "1");
    setGraphOpen(!graphOpen);
  };
  const graphRepo = repos.find((r) => r.root === actions.activeRoot) ?? repos[0];

  return (
    <div className="sidebar scm-view" data-ctx="scm">
      <div className="sidebar-header">
        <span>SOURCE CONTROL</span>
        <span className="sidebar-header-actions">
          <button className="icon-button" title="Refresh" onClick={() => void actions.git("refresh")}>
            <ThemeIcon id="refresh" />
          </button>
        </span>
      </div>
      <div className="scm-repos">
        {repos.length === 0 ? (
          <NoRepository folders={folders} actions={actions} />
        ) : (
          repos.map((repo) => (
            <div key={repo.root} className={`scm-repo-wrap ${repos.length > 1 && repo.root === graphRepo?.root ? "active" : ""}`} onMouseDownCapture={() => actions.setActive(repo.root)} onFocusCapture={() => actions.setActive(repo.root)}>
              <RepoSection repo={repo} showName={repos.length > 1} actions={actions} />
            </div>
          ))
        )}
      </div>
      {graphRepo && (
        <div className={`scm-graph ${graphOpen ? "open" : ""}`}>
          <GraphSection repo={graphRepo} repos={repos} open={graphOpen} onToggle={toggleGraph} actions={actions} />
        </div>
      )}
    </div>
  );
}

function NoRepository({ folders, actions }: { folders: WorkspaceFolderInfo[]; actions: ScmActions }) {
  if (folders.length === 0) {
    return (
      <div className="empty-hint scm-empty">
        <p>Open a folder that contains a git repository, or one to start tracking.</p>
        <button className="btn btn-primary" onClick={actions.openFolder}>
          Open Folder
        </button>
      </div>
    );
  }
  return (
    <div className="empty-hint scm-empty">
      <p>The open folder{folders.length > 1 ? "s aren't git repositories" : " isn't a git repository"}. Initialize one to track changes with git.</p>
      {folders.map((f) => (
        <button key={f.id} className="btn btn-primary" onClick={() => void actions.git("init", f.path)}>
          Initialize Repository{folders.length > 1 ? ` in ${f.name}` : ""}
        </button>
      ))}
    </div>
  );
}

function RepoSection({ repo, showName, actions }: { repo: RepoState; showName: boolean; actions: ScmActions }) {
  const storageKey = `oneclient.scm.message.${repo.root}`;
  const [message, setMessage] = useState(() => sessionStorage.getItem(storageKey) ?? "");
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<ChangeGroup>>(new Set());
  useEffect(() => sessionStorage.setItem(storageKey, message), [message, storageKey]);
  // A merge suggests its message.
  useEffect(() => {
    if (repo.mergeMessage && !message) setMessage(repo.mergeMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.mergeMessage]);

  const changes = [...repo.unstaged, ...repo.untracked];
  const total = repo.staged.length + changes.length + repo.conflicts.length;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      /* the caller shows the error */
    } finally {
      setBusy(false);
    }
  };

  const commit = (o: { amend?: boolean; then?: "push" | "sync"; all?: boolean } = {}) =>
    run(async () => {
      const smart = o.all === undefined && repo.staged.length === 0 && !o.amend;
      const stageAll = o.all || smart;
      if (stageAll && changes.length === 0 && !o.amend) throw new Error("There are no changes to commit.");
      // Nothing staged: committing everything is a big step — ask, like VS Code.
      if (
        smart &&
        !(await actions.confirm(
          "Commit All Changes?",
          `There are no staged changes in ${repo.name}. Stage all ${changes.length} change${changes.length === 1 ? "" : "s"} on "${repo.branch ?? "HEAD"}" and commit them?`,
          "Stage All & Commit",
        ))
      )
        return;
      await actions.git("commit", repo.root, message, { amend: o.amend, stageAll });
      setMessage("");
      if (o.then === "push") await actions.git("push", repo.root);
      if (o.then === "sync") await actions.git("sync", repo.root);
    });

  const branch = repo.branch ?? (repo.headSha ? repo.headSha.slice(0, 8) : "(no commits)");
  let primary: { label: string; icon: string; title: string; run: () => void };
  if (total > 0 || !repo.headSha) {
    primary = {
      label: repo.staged.length === 0 && changes.length > 0 ? "Commit" : "Commit",
      icon: "✓",
      title: repo.staged.length === 0 && changes.length > 0 ? "Stage all changes and commit them (Ctrl+Enter)" : "Commit the staged changes (Ctrl+Enter)",
      run: () => void commit(),
    };
  } else if (repo.branch && !repo.upstream && repo.remotes.length > 0) {
    primary = { label: "Publish Branch", icon: "☁", title: `Push ${repo.branch} and track it`, run: () => void run(() => actions.git("push", repo.root)) };
  } else if (repo.upstream && (repo.ahead || repo.behind)) {
    primary = { label: `Sync Changes ${repo.behind ? `${repo.behind}↓ ` : ""}${repo.ahead ? `${repo.ahead}↑` : ""}`, icon: "⟳", title: `Pull then push (${repo.upstream})`, run: () => void run(() => actions.git("sync", repo.root)) };
  } else primary = { label: "Commit", icon: "✓", title: "Nothing to commit", run: () => void commit() };

  const moreMenu = (e: React.MouseEvent) => {
    const g = (method: Parameters<typeof actions.git>[0], ...args: unknown[]) => () => void run(() => actions.git(method, repo.root, ...args));
    actions.menu(e, [
      { id: "commit", label: "Commit", run: () => void commit() },
      { id: "commitStaged", label: "Commit Staged", run: () => (repo.staged.length ? void commit({ all: false }) : void actions.confirm("Nothing Staged", "Stage some changes first (the + on a file).", "OK")) },
      { id: "commitAll", label: "Commit All", run: () => void commit({ all: true }) },
      { id: "amend", label: "Commit (Amend)", run: () => void commit({ amend: true }) },
      { id: "commitPush", label: "Commit & Push", run: () => void commit({ then: "push" }) },
      { id: "commitSync", label: "Commit & Sync", run: () => void commit({ then: "sync" }) },
      { id: "pull", label: "Pull", separator: true, run: g("pull") },
      { id: "push", label: "Push", run: g("push") },
      { id: "fetch", label: "Fetch", run: g("fetch") },
      { id: "sync", label: "Sync", run: g("sync") },
      { id: "checkout", label: "Checkout to…", separator: true, run: () => actions.pickBranch(repo) },
      { id: "branch", label: "Create Branch…", run: () => actions.createBranch(repo) },
      { id: "stageAll", label: "Stage All Changes", separator: true, run: g("stageAll") },
      { id: "unstageAll", label: "Unstage All Changes", run: g("unstageAll") },
      {
        id: "discardAll",
        label: "Discard All Changes",
        danger: true,
        run: () =>
          void actions.confirm("Discard All Changes", `Discard ALL changes in ${repo.name}? Untracked files are deleted. This can't be undone.`, "Discard All").then((ok) => {
            if (ok) void run(() => actions.git("discard", repo.root, changes.map((c) => c.path)));
          }),
      },
    ]);
  };

  const toggle = (g: ChangeGroup) => setCollapsed((prev) => (prev.has(g) ? new Set([...prev].filter((x) => x !== g)) : new Set(prev).add(g)));

  return (
    <div className="scm-repo">
      {showName && (
        <div className="scm-repo-head" title={repo.root}>
          <ThemeIcon id="source-control" size={14} />
          <span className="scm-repo-name">{repo.name}</span>
          <button className="scm-branch-chip" onClick={() => actions.pickBranch(repo)} title="Checkout to…">
            ⎇ {branch}
          </button>
        </div>
      )}
      {repo.error && <div className="scm-error">{repo.error}</div>}
      {repo.operation && (
        <div className="scm-banner">
          {repo.operation === "merge" ? "Merging" : repo.operation === "rebase" ? "Rebasing" : repo.operation === "cherry-pick" ? "Cherry-picking" : "Reverting"} — resolve the conflicts, stage the files, then commit.
        </div>
      )}
      <div className="scm-commit">
        <textarea
          className="scm-message"
          value={message}
          rows={Math.min(8, Math.max(1, message.split("\n").length))}
          placeholder={`Message (Ctrl+Enter to commit on "${branch}")`}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
          spellCheck
        />
        <div className="scm-commit-buttons">
          <button className="btn btn-primary scm-primary" disabled={busy} onClick={primary.run} title={primary.title}>
            {busy ? "⟳ Working…" : `${primary.icon} ${primary.label}`}
          </button>
          <button className="btn btn-primary scm-more" disabled={busy} onClick={moreMenu} title="More Actions…">
            <ThemeIcon id="chevron-down" size={14} />
          </button>
        </div>
      </div>

      {repo.conflicts.length > 0 && (
        <Group title="Merge Changes" group="merge" items={repo.conflicts} repo={repo} collapsed={collapsed.has("merge")} onToggle={() => toggle("merge")} actions={actions} run={run} />
      )}
      {repo.staged.length > 0 && (
        <Group title="Staged Changes" group="staged" items={repo.staged} repo={repo} collapsed={collapsed.has("staged")} onToggle={() => toggle("staged")} actions={actions} run={run} />
      )}
      <Group title="Changes" group="changes" items={changes} repo={repo} collapsed={collapsed.has("changes")} onToggle={() => toggle("changes")} actions={actions} run={run} />
    </div>
  );
}

function Group({
  title,
  group,
  items,
  repo,
  collapsed,
  onToggle,
  actions,
  run,
}: {
  title: string;
  group: ChangeGroup;
  items: Change[];
  repo: RepoState;
  collapsed: boolean;
  onToggle: () => void;
  actions: ScmActions;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const paths = items.map((c) => c.path);
  const discard = (targets: string[], label: string) =>
    void actions.confirm("Discard Changes", `Discard changes in ${label}? Untracked files are deleted. This can't be undone.`, "Discard").then((ok) => {
      if (ok) void run(() => actions.git("discard", repo.root, targets));
    });
  return (
    <div className="scm-group">
      <div className="scm-group-head" onClick={onToggle}>
        <ThemeIcon id={collapsed ? "chevron-right" : "chevron-down"} size={14} />
        <span className="scm-group-title">{title}</span>
        <span className="scm-group-actions" onClick={(e) => e.stopPropagation()}>
          {group === "changes" && items.length > 0 && (
            <>
              <button className="icon-button" title="Discard All Changes" onClick={() => discard(paths, `${items.length} file(s)`)}>
                ↶
              </button>
              <button className="icon-button" title="Stage All Changes" onClick={() => void run(() => actions.git("stageAll", repo.root))}>
                +
              </button>
            </>
          )}
          {group === "staged" && (
            <button className="icon-button" title="Unstage All Changes" onClick={() => void run(() => actions.git("unstageAll", repo.root))}>
              −
            </button>
          )}
          {group === "merge" && (
            <button className="icon-button" title="Stage All Merge Changes (mark resolved)" onClick={() => void run(() => actions.git("stage", repo.root, paths))}>
              +
            </button>
          )}
        </span>
        <span className="section-count">{items.length}</span>
      </div>
      {!collapsed &&
        items.map((c) => (
          <ChangeRow
            key={`${group}:${c.path}`}
            change={c}
            group={group}
            repo={repo}
            actions={actions}
            onStage={() => void run(() => actions.git("stage", repo.root, [c.path]))}
            onUnstage={() => void run(() => actions.git("unstage", repo.root, [c.path]))}
            onDiscard={() => discard([c.path], `"${baseName(c.path)}"`)}
          />
        ))}
    </div>
  );
}

function FileIcon({ name }: { name: string }) {
  const icon = useResourceIcon({ name, kind: "file" });
  return icon ? <AssetIcon pluginId="" icon={icon} size={16} /> : <ThemeIcon id="file" />;
}

function ChangeRow({
  change,
  group,
  repo,
  actions,
  onStage,
  onUnstage,
  onDiscard,
}: {
  change: Change;
  group: ChangeGroup;
  repo: RepoState;
  actions: ScmActions;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}) {
  const name = baseName(change.path);
  const open = () => {
    if (change.status === "?" || change.status === "U") return actions.openFile(repo, change.path);
    const s = diffSidesFor(repo, change, group);
    actions.openDiff(repo, change.path, s.left, s.right, `${name} (${s.label})`, change.origPath);
  };
  return (
    <div
      className={`scm-change status-${change.status === "?" ? "U2" : change.status}`}
      onClick={open}
      title={`${change.origPath ? `${change.origPath} → ` : ""}${change.path} • ${STATUS_LABEL[change.status] ?? change.status}`}
      onContextMenu={(e) => {
        e.preventDefault();
        actions.menu(e, [
          { id: "open", label: "Open Changes", run: open },
          { id: "file", label: "Open File", run: () => actions.openFile(repo, change.path) },
          ...(group === "staged" ? [{ id: "unstage", label: "Unstage Changes", separator: true, run: onUnstage }] : [{ id: "stage", label: "Stage Changes", separator: true, run: onStage }]),
          ...(group === "changes" ? [{ id: "discard", label: "Discard Changes", danger: true, run: onDiscard }] : []),
        ]);
      }}
    >
      <FileIcon name={name} />
      <span className={`scm-name ${change.status === "D" ? "deleted" : ""}`}>{name}</span>
      <span className="scm-dir">{dirName(change.path)}</span>
      <span className="scm-row-actions" onClick={(e) => e.stopPropagation()}>
        {change.status !== "D" && (
          <button className="icon-button" title="Open File" onClick={() => actions.openFile(repo, change.path)}>
            <ThemeIcon id="go-to-file" size={14} />
          </button>
        )}
        {group === "changes" && (
          <button className="icon-button" title="Discard Changes" onClick={onDiscard}>
            ↶
          </button>
        )}
        {group === "staged" ? (
          <button className="icon-button" title="Unstage Changes" onClick={onUnstage}>
            −
          </button>
        ) : (
          <button className="icon-button" title={group === "merge" ? "Stage (mark as resolved)" : "Stage Changes"} onClick={onStage}>
            +
          </button>
        )}
      </span>
      <span className="scm-status">{change.status === "?" ? "U" : change.status === "U" ? "!" : change.status}</span>
    </div>
  );
}

// ---- graph ------------------------------------------------------------------------------------------------------------

const LANE_W = 14;
const ROW_H = 22;
const LANE_COLORS = ["#4fa3ff", "#e5b847", "#c77dff", "#3fc28c", "#ff7a7a", "#57d0e0", "#f08bd0", "#b5cc57"];
const laneX = (lane: number) => 8 + lane * LANE_W;

function GraphCell({ row, head }: { row: GraphRow; head: boolean }) {
  const w = laneX(row.width - 1) + 10;
  const mid = ROW_H / 2;
  const path = (x1: number, y1: number, x2: number, y2: number) =>
    x1 === x2 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
  return (
    <svg width={w} height={ROW_H} className="graph-svg" aria-hidden>
      {row.top.map((s, i) => (
        <path key={`t${i}`} d={path(laneX(s.from), 0, laneX(s.to), mid)} stroke={LANE_COLORS[s.color % LANE_COLORS.length]} fill="none" strokeWidth={2} />
      ))}
      {row.bottom.map((s, i) => (
        <path key={`b${i}`} d={path(laneX(s.from), mid, laneX(s.to), ROW_H)} stroke={LANE_COLORS[s.color % LANE_COLORS.length]} fill="none" strokeWidth={2} />
      ))}
      <circle
        cx={laneX(row.lane)}
        cy={mid}
        r={head ? 5 : 4}
        fill={head ? "var(--bg-sidebar, #252526)" : LANE_COLORS[row.color % LANE_COLORS.length]}
        stroke={LANE_COLORS[row.color % LANE_COLORS.length]}
        strokeWidth={2}
      />
    </svg>
  );
}

function RefBadges({ refs }: { refs: string[] }) {
  return (
    <>
      {refs.map((r) => {
        const head = r.startsWith("HEAD -> ");
        const name = head ? r.slice(8) : r;
        const kind = name.startsWith("tag: ") ? "tag" : head ? "head" : name.includes("/") ? "remote" : r === "HEAD" ? "head" : "local";
        return (
          <span key={r} className={`graph-ref ref-${kind}`} title={r}>
            {kind === "tag" ? `🏷 ${name.slice(5)}` : kind === "remote" ? `☁ ${name}` : name}
          </span>
        );
      })}
    </>
  );
}

function GraphSection({ repo, repos, open, onToggle, actions }: { repo: RepoState; repos: RepoState[]; open: boolean; onToggle: () => void; actions: ScmActions }) {
  const [all, setAll] = useState(() => localStorage.getItem("oneclient.scm.graphAll") === "1");
  const [commits, setCommits] = useState<Commit[]>([]);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [files, setFiles] = useState<Change[] | null>(null);
  const [details, setDetails] = useState<{ body: string } | null>(null);
  const reload = useRef(0);

  // Re-read when HEAD moves, refs change (ahead/behind), or the toggle flips.
  const key = `${repo.root}|${repo.headSha}|${repo.ahead}|${repo.behind}|${repo.upstream}|${all}`;
  useEffect(() => {
    if (!open) return;
    const id = ++reload.current;
    actions
      .git("log", repo.root, { all, limit: 400 })
      .then((list) => {
        if (id !== reload.current) return;
        setCommits(list as Commit[]);
        setError("");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);

  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const width = useMemo(() => rows.reduce((w, r) => Math.max(w, r.width), 1), [rows]);

  const toggleCommit = (c: Commit) => {
    if (expanded === c.sha) return setExpanded(null);
    setExpanded(c.sha);
    setFiles(null);
    setDetails(null);
    void actions.git("commitFiles", repo.root, c.sha).then((f) => setFiles(f as Change[]));
    void actions.git("commitDetails", repo.root, c.sha).then((d) => setDetails(d as { body: string }));
  };

  return (
    <>
      <div className="scm-graph-head" onClick={onToggle}>
        <ThemeIcon id={open ? "chevron-down" : "chevron-right"} size={14} />
        <span className="scm-group-title">GRAPH</span>
        {repos.length > 1 && (
          <select className="graph-repo" value={repo.root} onClick={(e) => e.stopPropagation()} onChange={(e) => actions.setActive(e.target.value)} title="Repository">
            {repos.map((r) => (
              <option key={r.root} value={r.root}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        <span className="scm-group-actions always" onClick={(e) => e.stopPropagation()}>
          <button
            className={`icon-button graph-all ${all ? "on" : ""}`}
            title={all ? "Showing all branches — show the current branch only" : "Showing the current branch (and its upstream) — show all branches"}
            onClick={() => {
              localStorage.setItem("oneclient.scm.graphAll", all ? "0" : "1");
              setAll(!all);
            }}
          >
            {all ? "All" : "Auto"}
          </button>
          <button className="icon-button" title="Fetch" onClick={() => void actions.git("fetch", repo.root)}>
            ⇣
          </button>
          <button className="icon-button" title="Pull" onClick={() => void actions.git("pull", repo.root)}>
            ↓
          </button>
          <button className="icon-button" title="Push" onClick={() => void actions.git("push", repo.root)}>
            ↑
          </button>
          <button className="icon-button" title="Refresh" onClick={() => void actions.git("refresh")}>
            <ThemeIcon id="refresh" size={14} />
          </button>
        </span>
      </div>
      {open && (
        <div className="scm-graph-body" style={{ ["--graph-w" as string]: `${laneX(width - 1) + 10}px` }}>
          {error && <div className="scm-error">{error}</div>}
          {!error && commits.length === 0 && <div className="empty-hint">No commits yet.</div>}
          {rows.map((row, i) => {
            const c = commits[i]!;
            const head = c.sha === repo.headSha;
            const isOpen = expanded === c.sha;
            return (
              <Fragment key={c.sha}>
                <div className={`graph-row ${head ? "head" : ""} ${isOpen ? "open" : ""}`} onClick={() => toggleCommit(c)} title={`${c.sha.slice(0, 10)} • ${c.author} <${c.email}> • ${new Date(c.date * 1000).toLocaleString()}\n\n${c.subject}`}>
                  <span className="graph-lanes">
                    <GraphCell row={row} head={head} />
                  </span>
                  <span className="graph-subject">{c.subject}</span>
                  <span className="graph-author">{c.author}</span>
                  <RefBadges refs={c.refs} />
                </div>
                {isOpen && (
                  <div className="graph-details">
                    <div className="graph-meta">
                      <code>{c.sha.slice(0, 10)}</code> · {c.author} · {relTime(c.date)}
                    </div>
                    {details && details.body !== c.subject && <pre className="graph-body">{details.body}</pre>}
                    {!files && <div className="empty-hint">Loading…</div>}
                    {files?.map((f) => {
                      const name = baseName(f.path);
                      const parent = c.parents[0];
                      return (
                        <div
                          key={f.path}
                          className={`scm-change graph-file status-${f.status}`}
                          onClick={() =>
                            actions.openDiff(repo, f.path, f.status === "A" || !parent ? "empty" : `${c.sha}^`, f.status === "D" ? "empty" : c.sha, `${name} (${c.sha.slice(0, 7)})`, f.origPath)
                          }
                          title={f.path}
                        >
                          <FileIcon name={name} />
                          <span className={`scm-name ${f.status === "D" ? "deleted" : ""}`}>{name}</span>
                          <span className="scm-dir">{dirName(f.path)}</span>
                          <span className="scm-status">{f.status}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      )}
    </>
  );
}
