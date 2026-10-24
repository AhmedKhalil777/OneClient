import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOG_FORMAT, git, parseLog, parseNameStatus, parseRefs, parseStatus } from "../src/git/git.js";
import { diffLines, diffStats, sideBySide, toLines } from "../src/shared/diff.js";
import { layoutGraph } from "../src/shared/git-graph.js";
import { parseJsonc, tasksFromJson } from "../src/tasks/task-runner.js";
import { TaskService } from "../src/tasks/task-service.js";

describe("git output parsers", () => {
  it("parses porcelain v2 status: branch, ahead/behind, staged, unstaged, renames, untracked, conflicts", () => {
    const raw = [
      "# branch.oid 1234",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 a b src/app.ts",
      "1 .M N... 100644 100644 100644 a b README with space.md",
      "1 MM N... 100644 100644 100644 a b both.ts",
      "2 R. N... 100644 100644 100644 a b R100 new/name.ts",
      "old/name.ts",
      "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
      "? notes.txt",
      "",
    ].join("\0");
    const s = parseStatus(raw);
    expect(s).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1, headSha: "1234", detached: false });
    expect(s.staged).toEqual([
      { path: "src/app.ts", status: "M" },
      { path: "both.ts", status: "M" },
      { path: "new/name.ts", status: "R", origPath: "old/name.ts" },
    ]);
    expect(s.unstaged.map((c) => c.path)).toEqual(["README with space.md", "both.ts"]);
    expect(s.untracked).toEqual([{ path: "notes.txt", status: "?" }]);
    expect(s.conflicts).toEqual([{ path: "conflict.txt", status: "U" }]);
    expect(parseStatus("# branch.oid (initial)\0# branch.head (detached)\0")).toMatchObject({ headSha: null, detached: true, branch: null });
  });

  it("parses log, refs and name-status", () => {
    const log = parseLog("a1\x1fp1 p2\x1fAda\x1fada@x.io\x1f1700000000\x1fHEAD -> main, origin/main, tag: v1\x1fMerge it\x1e\nb2\x1f\x1fBo\x1fb@x\x1f1\x1f\x1fFirst\x1e");
    expect(log[0]).toMatchObject({ sha: "a1", parents: ["p1", "p2"], refs: ["HEAD -> main", "origin/main", "tag: v1"], subject: "Merge it" });
    expect(log[1]!.parents).toEqual([]);
    const refs = parseRefs("refs/heads/main\x1fmain\x1fabc\x1forigin/main\x1f*\nrefs/remotes/origin/HEAD\x1forigin\x1fabc\x1f\x1f \nrefs/remotes/origin/dev\x1forigin/dev\x1fdef\x1f\x1f \nrefs/tags/v1\x1fv1\x1f123\x1f\x1f \n");
    expect(refs).toEqual([
      { name: "main", kind: "local", sha: "abc", upstream: "origin/main", current: true },
      { name: "origin/dev", kind: "remote", sha: "def", current: false },
      { name: "v1", kind: "tag", sha: "123", current: false },
    ]);
    expect(parseNameStatus("M\0a.ts\0R087\0old.ts\0new.ts\0A\0b.ts\0")).toEqual([
      { path: "a.ts", status: "M" },
      { path: "new.ts", origPath: "old.ts", status: "R" },
      { path: "b.ts", status: "A" },
    ]);
  });
});

describe("git against a real repository", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oneclient-git-"));
    const g = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@x.io");
    g("config", "user.name", "Tester");
    writeFileSync(join(dir, "a.txt"), "one\n");
    g("add", "-A");
    g("commit", "-q", "-m", "first");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads status and history through the runner", async () => {
    const s = parseStatus(await git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], { cwd: dir }));
    expect(s.branch).toBe("main");
    expect(s.unstaged).toEqual([{ path: "a.txt", status: "M" }]);
    expect(s.untracked).toEqual([{ path: "b.txt", status: "?" }]);
    const log = parseLog(await git(["log", `--format=${LOG_FORMAT}`], { cwd: dir }));
    expect(log.map((c) => c.subject)).toEqual(["first"]);
    await expect(git(["log", "--no-such-flag"], { cwd: dir })).rejects.toThrow(/unrecognized argument|unknown option/);
  });
});

describe("diff", () => {
  it("diffs lines and pairs changed lines side by side", () => {
    const a = toLines("a\nb\nc\nd\n");
    const b = toLines("a\nB\nc\nd\ne\n");
    const ops = diffLines(a, b);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
    const rows = sideBySide(a, b, ops);
    expect(rows.map((r) => r.kind)).toEqual(["same", "mod", "same", "same", "add"]);
    expect(rows[1]).toEqual({ kind: "mod", left: { line: 2, text: "b" }, right: { line: 2, text: "B" } });
    expect(rows[4]).toEqual({ kind: "add", right: { line: 5, text: "e" } });
  });

  it("handles empty sides and finds a minimal script", () => {
    expect(sideBySide([], ["x"]).map((r) => r.kind)).toEqual(["add"]);
    expect(sideBySide(["x"], []).map((r) => r.kind)).toEqual(["del"]);
    const ops = diffLines(toLines("1\n2\n3\n4\n5\n6"), toLines("1\n3\n4\nX\n5\n6"));
    expect(diffStats(ops)).toEqual({ added: 1, removed: 1 });
  });
});

describe("commit graph", () => {
  it("puts a linear history in one lane and a merge's second parent in another", () => {
    // M merges F (feature) into C; history: M → C → B → A, M → F → B
    const rows = layoutGraph([
      { sha: "M", parents: ["C", "F"] },
      { sha: "C", parents: ["B"] },
      { sha: "F", parents: ["B"] },
      { sha: "B", parents: ["A"] },
      { sha: "A", parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0, 0]);
    expect(rows[0]!.bottom).toEqual(expect.arrayContaining([expect.objectContaining({ from: 0, to: 1 })]));
    expect(rows[3]!.top).toEqual(expect.arrayContaining([expect.objectContaining({ from: 1, to: 0 })]));
    expect(rows[4]!.bottom).toEqual([]);
  });
});

describe("task runner", () => {
  it("reads VS Code style tasks.json (JSONC, variables, groups)", () => {
    const doc = parseJsonc(`{
      // build tasks
      "version": "2.0.0",
      "tasks": [
        { "label": "build", "type": "shell", "command": "dotnet", "args": ["build", "\${workspaceFolder}/App.sln"], "group": { "kind": "build", "isDefault": true }, },
        { "label": "lint", "type": "shell", "command": "eslint ." , "options": { "cwd": "\${workspaceFolder}/web" } },
        /* no command: skipped */ { "label": "bad" },
      ],
    }`);
    const defs = tasksFromJson(doc, { id: "f", name: "repo", path: "C:\\\\src\\\\repo" }, "tasks.json");
    expect(defs.map((d) => d.label)).toEqual(["build", "lint"]);
    expect(defs[0]).toMatchObject({ group: "build", isDefault: true, command: "dotnet build C:\\\\src\\\\repo/App.sln" });
    expect(defs[1]!.cwd.split("\\").join("/")).toMatch(/repo\/web$/);
  });

  it("tracks a task's lifecycle, output and cancellation", async () => {
    const service = new TaskService();
    let cancelled = false;
    const t = service.start({ title: "Long", source: "test", cancellable: true, onCancel: () => (cancelled = true) });
    t.log("hello ");
    t.report({ detail: "working", progress: 0.5 });
    expect(service.list()[0]).toMatchObject({ state: "running", progress: 0.5 });
    expect(service.cancel(t.id)).toBe(true);
    expect(cancelled).toBe(true);
    t.fail("killed");
    expect(service.list()[0]!.state).toBe("cancelled");
    await expect(service.run({ title: "Boom", source: "test" }, async () => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
    expect(service.list().find((x) => x.title === "Boom")).toMatchObject({ state: "failed", detail: "nope" });
    expect(service.output(t.id)).toBe("hello ");
    service.clearFinished();
    expect(service.list()).toEqual([]);
  });
});
