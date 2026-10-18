import { spawn } from "node:child_process";

/**
 * Runs the user's own `git` (on PATH) and parses its machine-readable output. Using the real CLI keeps behaviour
 * identical to the command line: hooks, credential helpers, config, LFS…
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitRunOptions {
  cwd: string;
  /** Fed to stdin. */
  input?: string;
  /** Streamed stderr (progress lines of fetch / pull / push). */
  onStderr?: (chunk: string) => void;
  /** Kill the process when this signal fires. */
  signal?: AbortSignal;
}

let gitPath = "git";
export const setGitPath = (path: string): void => void (gitPath = path);

/** Runs git and returns stdout as a Buffer (file contents can be binary). Throws GitError on a non-zero exit. */
export function runGit(args: string[], o: GitRunOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath, args, {
      cwd: o.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        // Never block on a terminal prompt; GUI credential helpers (Git Credential Manager) still work.
        GIT_TERMINAL_PROMPT: "0",
        // Read-only commands (status) shouldn't take locks another git process may need.
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
        LANG: "C",
      },
      ...(o.signal ? { signal: o.signal } : {}),
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString("utf-8");
      err += text;
      o.onStderr?.(text);
    });
    child.on("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "ENOENT" ? new GitError("Git isn't installed (or not on PATH). Install it from git-scm.com and restart oneClient.", null, "") : e),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new GitError(cleanError(err) || `git ${args[0]} failed (exit ${code}).`, code, err));
    });
    if (o.input !== undefined) child.stdin.end(o.input);
    else child.stdin.end();
  });
}

export async function git(args: string[], o: GitRunOptions): Promise<string> {
  return (await runGit(args, o)).toString("utf-8");
}

/** The useful part of git's stderr ("error: …", "fatal: …", hints dropped). */
export function cleanError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("hint:"));
  const important = lines.filter((l) => /^(fatal|error):/i.test(l));
  return (important.length ? important : lines).join("\n").replace(/^(fatal|error):\s*/gim, "");
}

// ---- status ---------------------------------------------------------------------------------------------------------

/** M modified, A added, D deleted, R renamed, C copied, T type changed, U conflicted, ? untracked. */
export type ChangeStatus = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?";

export interface Change {
  /** Repo-relative, "/"-separated. */
  path: string;
  /** Renames / copies: where it came from. */
  origPath?: string;
  status: ChangeStatus;
}

export interface StatusResult {
  branch: string | null;
  detached: boolean;
  headSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: Change[];
  unstaged: Change[];
  untracked: Change[];
  conflicts: Change[];
}

const letter = (c: string): ChangeStatus => (c === "M" || c === "A" || c === "D" || c === "R" || c === "C" || c === "T" ? c : "M");

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatus(raw: string): StatusResult {
  const r: StatusResult = { branch: null, detached: false, headSha: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [] };
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice(13);
      r.headSha = oid === "(initial)" ? null : oid;
    } else if (line.startsWith("# branch.head ")) {
      const head = line.slice(14);
      r.detached = head === "(detached)";
      r.branch = r.detached ? null : head;
    } else if (line.startsWith("# branch.upstream ")) r.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        r.ahead = Number(m[1]);
        r.behind = Number(m[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // 1 XY sub mH mI mW hH hI path   |   2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const fields = line.split(" ");
      const xy = fields[1]!;
      const path = fields.slice(line.startsWith("1 ") ? 8 : 9).join(" ");
      const origPath = line.startsWith("2 ") ? parts[++i] : undefined;
      if (xy[0] !== ".") r.staged.push({ path, status: letter(xy[0]!), ...(origPath && xy[0] === "R" ? { origPath } : {}) });
      if (xy[1] !== ".") r.unstaged.push({ path, status: letter(xy[1]!), ...(origPath && xy[1] === "R" ? { origPath } : {}) });
    } else if (line.startsWith("u ")) {
      r.conflicts.push({ path: line.split(" ").slice(10).join(" "), status: "U" });
    } else if (line.startsWith("? ")) {
      r.untracked.push({ path: line.slice(2), status: "?" });
    }
  }
  return r;
}

// ---- log --------------------------------------------------------------------------------------------------------------

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  /** Epoch seconds. */
  date: number;
  /** Ref names: "HEAD -> main", "origin/main", "tag: v1.0". */
  refs: string[];
  subject: string;
}

/** `--format` for parseLog: fields split by \x1f, commits by \x1e. */
export const LOG_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e";

export function parseLog(raw: string): Commit[] {
  return raw
    .split("\x1e")
    .map((s) => s.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [sha = "", parents = "", author = "", email = "", date = "0", refs = "", subject = ""] = rec.split("\x1f");
      return {
        sha,
        parents: parents.split(" ").filter(Boolean),
        author,
        email,
        date: Number(date),
        refs: refs
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        subject,
      };
    });
}

// ---- refs -------------------------------------------------------------------------------------------------------------

export interface Ref {
  /** "main", "origin/main", "v1.0". */
  name: string;
  kind: "local" | "remote" | "tag";
  sha: string;
  upstream?: string;
  current: boolean;
}

export const REF_FORMAT = "%(refname)%1f%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(HEAD)";

export function parseRefs(raw: string): Ref[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line): Ref[] => {
      const [full = "", short = "", sha = "", upstream = "", head = ""] = line.split("\x1f");
      const kind = full.startsWith("refs/heads/") ? "local" : full.startsWith("refs/remotes/") ? "remote" : full.startsWith("refs/tags/") ? "tag" : null;
      if (!kind || full.endsWith("/HEAD")) return [];
      return [{ name: short, kind, sha, ...(upstream ? { upstream } : {}), current: head === "*" }];
    });
}

// ---- changed files of a commit ----------------------------------------------------------------------------------------

/** Parses `git diff-tree -r -M --name-status -z …`. */
export function parseNameStatus(raw: string): Change[] {
  const parts = raw.split("\0").filter((p) => p !== "");
  const out: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!;
    if (!/^[A-Z]/.test(code)) continue; // the commit id line when present
    const s = code[0]!;
    if (s === "R" || s === "C") {
      const from = parts[++i] ?? "";
      const to = parts[++i] ?? "";
      out.push({ path: to, origPath: from, status: s });
    } else out.push({ path: parts[++i] ?? "", status: letter(s) });
  }
  return out;
}

/** A NUL byte in the first 8 KB means binary (git's own heuristic). */
export const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8000).includes(0);
