import { type FSWatcher, existsSync, watch } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { TaskService } from "../tasks/task-service.js";
import { type Change, type Commit, GitError, LOG_FORMAT, REF_FORMAT, type Ref, type StatusResult, git, isBinary, parseLog, parseNameStatus, parseRefs, parseStatus, runGit } from "./git.js";

/** A repository (one per git top-level containing an open folder). */
export interface RepoState extends StatusResult {
  /** The repository root (absolute) — also its id. */
  root: string;
  name: string;
  /** An operation in progress that needs the user (merge / rebase / cherry-pick conflicts). */
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  /** Suggested commit message (MERGE_MSG while merging). */
  mergeMessage?: string;
  remotes: string[];
  /** Set when reading the repo failed. */
  error?: string;
}

export interface Folder {
  id: string;
  path: string;
}

/** What a diff side shows: a commit-ish ("HEAD", "abc123", "abc123^"), the index, the working tree, or nothing. */
export type DiffSide = "worktree" | "index" | "empty" | string;
export type FileVersion = { kind: "text"; text: string } | { kind: "binary"; size: number } | { kind: "missing" };

const REFRESH_MS = 250;
const POLL_MS = 15_000;

/**
 * Source control (core): the git repositories of the open folders, kept up to date (a watcher on each `.git`, a
 * periodic status, and a refresh after any operation), and every operation the Source Control view offers. Network
 * operations run as background tasks so they show progress and can be cancelled.
 */
export class GitService {
  private repos = new Map<string, RepoState>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly listeners = new Set<(repos: RepoState[]) => void>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  /** Folder path → its repository root (null: not in a repository) — a folder's repo doesn't move. */
  private folderRoots = new Map<string, string | null>();
  /** The repositories of the folders open right now. */
  private roots = new Set<string>();
  private lastFolders: Folder[] = [];

  constructor(private readonly tasks: TaskService) {}

  // ---- repositories -----------------------------------------------------------------------------------------

  /** The workspace folders changed: find their repositories (again). */
  async setFolders(folders: Folder[]): Promise<void> {
    this.lastFolders = folders;
    const roots = new Set<string>();
    for (const f of folders) {
      let root = this.folderRoots.get(f.path);
      if (root === undefined) {
        root = await git(["rev-parse", "--show-toplevel"], { cwd: f.path })
          .then((out) => resolve(out.trim()))
          .catch(() => null);
        this.folderRoots.set(f.path, root);
      }
      if (root) roots.add(root);
    }
    for (const root of [...this.repos.keys()]) if (!roots.has(root)) this.drop(root);
    for (const root of roots) if (!this.roots.has(root)) this.watchRepo(root);
    this.roots = roots;
    await this.refresh();
    if (!this.poll) {
      this.poll = setInterval(() => this.scheduleRefresh(), POLL_MS);
      this.poll.unref();
    }
  }

  private drop(root: string): void {
    this.repos.delete(root);
    this.watchers.get(root)?.close();
    this.watchers.delete(root);
  }

  /** `.git` changes (HEAD moved, index written, refs updated) refresh the status. */
  private watchRepo(root: string): void {
    const gitDir = join(root, ".git");
    if (!existsSync(gitDir)) return;
    try {
      const w = watch(gitDir, { persistent: false }, (_event, file) => {
        // index.lock comes and goes during every git command — the final write triggers anyway.
        if (file && /\.lock$/.test(String(file))) return;
        this.scheduleRefresh();
      });
      w.on("error", () => undefined);
      this.watchers.set(root, w);
    } catch {
      /* some file systems don't support watching: the periodic refresh covers them */
    }
  }

  /** Debounced refresh (file saves, .git changes, window focus…). */
  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_MS);
  }

  /** Re-read every repository's state now. */
  async refresh(): Promise<RepoState[]> {
    const states = await Promise.all([...this.roots].map((root) => this.readState(root)));
    this.repos = new Map(states.map((s) => [s.root, s]));
    const list = this.list();
    for (const l of this.listeners) l(list);
    return list;
  }

  list(): RepoState[] {
    return [...this.repos.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  onChanged(listener: (repos: RepoState[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async readState(root: string): Promise<RepoState> {
    const name = basename(root);
    try {
      const [status, remotes] = await Promise.all([
        git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], { cwd: root }),
        git(["remote"], { cwd: root }).catch(() => ""),
      ]);
      const gitDir = join(root, ".git");
      const operation = existsSync(join(gitDir, "MERGE_HEAD"))
        ? "merge"
        : existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))
          ? "rebase"
          : existsSync(join(gitDir, "CHERRY_PICK_HEAD"))
            ? "cherry-pick"
            : existsSync(join(gitDir, "REVERT_HEAD"))
              ? "revert"
              : null;
      const mergeMessage = operation ? await readFile(join(gitDir, "MERGE_MSG"), "utf-8").catch(() => undefined) : undefined;
      return {
        root,
        name,
        ...parseStatus(status),
        operation,
        ...(mergeMessage ? { mergeMessage: mergeMessage.replace(/^#.*\n?/gm, "").trim() } : {}),
        remotes: remotes.split(/\r?\n/).filter(Boolean),
      };
    } catch (err) {
      return { root, name, branch: null, detached: false, headSha: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [], operation: null, remotes: [], error: msg(err) };
    }
  }

  private repo(root: unknown): RepoState {
    const r = typeof root === "string" ? this.repos.get(resolve(root)) : undefined;
    if (!r) throw new Error("That repository isn't open (any more).");
    return r;
  }

  /** Runs a local git command in a repo, then refreshes. */
  private async local(root: unknown, args: string[], input?: string): Promise<void> {
    const repo = this.repo(root);
    try {
      await git(args, { cwd: repo.root, ...(input !== undefined ? { input } : {}) });
    } finally {
      await this.refresh();
    }
  }

  // ---- changes --------------------------------------------------------------------------------------------------

  stage(root: unknown, paths: string[]): Promise<void> {
    return this.local(root, ["add", "-A", "--", ...paths]);
  }
  stageAll(root: unknown): Promise<void> {
    return this.local(root, ["add", "-A"]);
  }
  unstage(root: unknown, paths: string[]): Promise<void> {
    const repo = this.repo(root);
    // Before the first commit there is no HEAD to restore from.
    return repo.headSha ? this.local(root, ["restore", "--staged", "--", ...paths]) : this.local(root, ["rm", "--cached", "-r", "-q", "--", ...paths]);
  }
  unstageAll(root: unknown): Promise<void> {
    const repo = this.repo(root);
    return repo.headSha ? this.local(root, ["reset", "-q"]) : this.local(root, ["rm", "--cached", "-r", "-q", "."]);
  }

  /** Throws away working-tree changes: tracked files go back to their staged / committed state, untracked ones are deleted. */
  async discard(root: unknown, paths: string[]): Promise<void> {
    const repo = this.repo(root);
    const untracked = new Set(repo.untracked.map((c) => c.path));
    const tracked = paths.filter((p) => !untracked.has(p));
    const fresh = paths.filter((p) => untracked.has(p));
    try {
      if (tracked.length) await git(["restore", "--worktree", "--", ...tracked], { cwd: repo.root });
      for (const p of fresh) await rm(join(repo.root, ...p.split("/")), { recursive: true, force: true });
    } finally {
      await this.refresh();
    }
  }

  async commit(root: unknown, message: string, o: { amend?: boolean; stageAll?: boolean } = {}): Promise<void> {
    const repo = this.repo(root);
    if (!message.trim() && !o.amend) throw new Error("Type a commit message first.");
    if (o.stageAll) await git(["add", "-A"], { cwd: repo.root });
    const args = ["commit", "--cleanup=strip", "-F", "-"];
    if (o.amend) args.push("--amend", ...(message.trim() ? [] : ["--no-edit"]));
    try {
      await git(args, { cwd: repo.root, input: message });
    } finally {
      await this.refresh();
    }
  }

  // ---- branches -------------------------------------------------------------------------------------------------

  async refs(root: unknown): Promise<Ref[]> {
    const repo = this.repo(root);
    return parseRefs(await git(["for-each-ref", `--format=${REF_FORMAT}`, "--sort=-committerdate", "refs/heads", "refs/remotes", "refs/tags"], { cwd: repo.root }));
  }

  /** Switches branch; a remote branch ("origin/x") gets a local tracking branch. */
  async checkout(root: unknown, name: string): Promise<void> {
    const repo = this.repo(root);
    const refs = await this.refs(root);
    const ref = refs.find((r) => r.name === name);
    if (ref?.kind === "remote") {
      const local = name.slice(name.indexOf("/") + 1);
      const exists = refs.some((r) => r.kind === "local" && r.name === local);
      return this.local(repo.root, exists ? ["switch", local] : ["switch", "--track", name]);
    }
    return this.local(repo.root, ref?.kind === "tag" ? ["switch", "--detach", name] : ["switch", name]);
  }

  createBranch(root: unknown, name: string, from?: string): Promise<void> {
    if (!/^(?!\/|.*\/\/|.*\.\.|.*@\{|.*\.lock$)[^\s~^:?*[\\]+$/.test(name)) throw new Error(`"${name}" isn't a valid branch name.`);
    return this.local(root, ["switch", "-c", name, ...(from ? [from] : [])]);
  }

  deleteBranch(root: unknown, name: string, force = false): Promise<void> {
    return this.local(root, ["branch", force ? "-D" : "-d", name]);
  }

  // ---- network (background tasks) -----------------------------------------------------------------------------------

  private network(root: unknown, title: string, args: string[]): Promise<void> {
    const repo = this.repo(root);
    const controller = new AbortController();
    return this.tasks
      .run({ title: `${title} — ${repo.name}`, source: "Git", cancellable: true, command: `git ${args.join(" ")}`, cwd: repo.root, onCancel: () => controller.abort() }, async (task) => {
        task.log(`> git ${args.join(" ")}\n`);
        await runGit(args, {
          cwd: repo.root,
          signal: controller.signal,
          onStderr: (chunk) => {
            task.log(chunk.replace(/\r(?!\n)/g, "\n"));
            // "Receiving objects:  45% (450/1000)" → progress
            const m = /([A-Za-z ]+):\s+(\d+)%/.exec(chunk.split("\r").pop() ?? chunk);
            if (m) task.report({ detail: `${m[1]!.trim()} ${m[2]}%`, progress: Number(m[2]) / 100 });
          },
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) throw new Error(`${title} was cancelled.`);
        throw err;
      })
      .finally(() => void this.refresh());
  }

  fetch(root: unknown): Promise<void> {
    return this.network(root, "Fetch", ["fetch", "--all", "--prune", "--progress"]);
  }
  pull(root: unknown): Promise<void> {
    return this.network(root, "Pull", ["pull", "--progress"]);
  }
  push(root: unknown, o: { force?: boolean } = {}): Promise<void> {
    const repo = this.repo(root);
    // A branch without an upstream is published to the first remote (origin) and tracked.
    if (!repo.upstream && repo.branch) {
      const remote = repo.remotes.includes("origin") ? "origin" : repo.remotes[0];
      if (!remote) throw new Error("This repository has no remote to push to.");
      return this.network(root, "Publish Branch", ["push", "--progress", "-u", remote, repo.branch]);
    }
    return this.network(root, "Push", ["push", "--progress", ...(o.force ? ["--force-with-lease"] : [])]);
  }
  /** Pull, then push (VS Code's "Sync Changes"). */
  async sync(root: unknown): Promise<void> {
    const repo = this.repo(root);
    if (repo.upstream && repo.behind > 0) await this.pull(root);
    if (!repo.upstream || this.repo(root).ahead > 0 || repo.ahead > 0) await this.push(root);
  }

  async init(path: string): Promise<void> {
    await git(["init"], { cwd: path });
    this.folderRoots.delete(path);
    await this.setFolders(this.lastFolders);
  }

  // ---- history & content ------------------------------------------------------------------------------------------

  /** Commits for the graph: the current branch and its upstream, or every branch. */
  async log(root: unknown, o: { all?: boolean; limit?: number } = {}): Promise<Commit[]> {
    const repo = this.repo(root);
    if (!repo.headSha) return [];
    const revs = o.all ? ["--all"] : ["HEAD", ...(repo.upstream ? [repo.upstream] : [])];
    return parseLog(await git(["log", "--topo-order", `-n${Math.min(2000, o.limit ?? 300)}`, `--format=${LOG_FORMAT}`, ...revs, "--"], { cwd: repo.root }));
  }

  /** Files a commit changed (against its first parent). */
  async commitFiles(root: unknown, sha: string): Promise<Change[]> {
    const repo = this.repo(root);
    const parents = (await git(["rev-list", "--parents", "-n1", sha], { cwd: repo.root })).trim().split(" ").slice(1);
    const args = parents[0] ? ["diff-tree", "-r", "-M", "--name-status", "-z", parents[0], sha] : ["diff-tree", "-r", "-M", "--root", "--name-status", "-z", sha];
    return parseNameStatus(await git(args, { cwd: repo.root }));
  }

  /** The full message and details of one commit. */
  async commitDetails(root: unknown, sha: string): Promise<{ body: string; committer: string; date: number }> {
    const repo = this.repo(root);
    const [body = "", committer = "", date = "0"] = (await git(["show", "-s", "--format=%B%x1f%cn%x1f%ct", sha], { cwd: repo.root })).split("\x1f");
    return { body: body.trim(), committer, date: Number(date) };
  }

  /** A file as of a diff side. */
  async fileVersion(root: unknown, path: string, side: DiffSide): Promise<FileVersion> {
    const repo = this.repo(root);
    if (side === "empty") return { kind: "missing" };
    let buf: Buffer;
    try {
      buf = side === "worktree" ? await readFile(join(repo.root, ...path.split("/"))) : await runGit(["show", `${side === "index" ? "" : side}:${path}`], { cwd: repo.root });
    } catch {
      return { kind: "missing" };
    }
    if (isBinary(buf)) return { kind: "binary", size: buf.length };
    const text = buf.toString("utf-8").replace(/^﻿/, "");
    return { kind: "text", text: text.length > 4_000_000 ? text.slice(0, 4_000_000) : text };
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.close();
    if (this.poll) clearInterval(this.poll);
  }
}

const msg = (err: unknown) => (err instanceof GitError || err instanceof Error ? err.message : String(err));
