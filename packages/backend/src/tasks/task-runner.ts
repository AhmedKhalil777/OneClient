import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { TaskService } from "./task-service.js";

/** A runnable task found in a workspace folder. */
export interface TaskDefinition {
  /** Stable across detections: "<folder id>:<source>:<label>". */
  id: string;
  label: string;
  /** "npm" / "pnpm" / "yarn", "tasks.json", "dotnet". */
  source: string;
  /** The full shell command line. */
  command: string;
  cwd: string;
  folderId: string;
  folderName: string;
  group?: "build" | "test";
  /** tasks.json `isDefault` for its group. */
  isDefault?: boolean;
  detail?: string;
}

interface Folder {
  id: string;
  name: string;
  path: string;
}

/** Strips // and /* *\/ comments and trailing commas: tasks.json is JSONC. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const quote = (arg: string) => (/^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

/** ${workspaceFolder} & co. in tasks.json values. */
function substitute(value: string, folder: Folder): string {
  return value
    .replace(/\$\{workspaceFolder\}/g, folder.path)
    .replace(/\$\{workspaceRoot\}/g, folder.path)
    .replace(/\$\{workspaceFolderBasename\}/g, basename(folder.path))
    .replace(/\$\{pathSeparator\}/g, process.platform === "win32" ? "\\" : "/")
    .replace(/\$\{env:([\w]+)\}/g, (_m, name: string) => process.env[name] ?? "");
}

/** The package manager a folder uses, from its lockfile. */
function packageManager(dir: string): "pnpm" | "yarn" | "npm" {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

async function readJson(path: string, jsonc = false): Promise<unknown> {
  try {
    const text = await readFile(path, "utf-8");
    return jsonc ? parseJsonc(text) : JSON.parse(text);
  } catch {
    return undefined;
  }
}

type TasksJsonTask = {
  label?: string;
  type?: string;
  command?: string;
  args?: Array<string | { value?: string }>;
  script?: string;
  path?: string;
  options?: { cwd?: string };
  group?: string | { kind?: string; isDefault?: boolean };
  detail?: string;
  windows?: { command?: string; args?: TasksJsonTask["args"] };
};

/** Tasks from a VS Code-style tasks.json (shell / process / npm types). */
export function tasksFromJson(doc: unknown, folder: Folder, source: string): TaskDefinition[] {
  const tasks = (doc as { tasks?: TasksJsonTask[] } | undefined)?.tasks;
  if (!Array.isArray(tasks)) return [];
  const out: TaskDefinition[] = [];
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    const platform = process.platform === "win32" && t.windows ? { ...t, ...t.windows } : t;
    let command: string | undefined;
    if (t.type === "npm" && t.script) command = `${packageManager(resolve(folder.path, t.path ?? ""))} run ${quote(t.script)}`;
    else if (typeof platform.command === "string") {
      const args = (platform.args ?? []).map((a) => (typeof a === "string" ? a : (a?.value ?? ""))).map((a) => quote(substitute(a, folder)));
      command = [substitute(platform.command, folder), ...args].join(" ");
    }
    if (!command) continue;
    const label = t.label ?? (t.script ? `npm: ${t.script}` : command);
    const groupKind = typeof t.group === "string" ? t.group : t.group?.kind;
    const cwd = t.options?.cwd ? resolve(folder.path, substitute(t.options.cwd, folder)) : t.path ? resolve(folder.path, t.path) : folder.path;
    out.push({
      id: `${folder.id}:${source}:${label}`,
      label,
      source,
      command,
      cwd,
      folderId: folder.id,
      folderName: folder.name,
      ...(groupKind === "build" || groupKind === "test" ? { group: groupKind } : {}),
      ...(typeof t.group === "object" && t.group?.isDefault ? { isDefault: true } : {}),
      ...(t.detail ? { detail: t.detail } : {}),
    });
  }
  return out;
}

/**
 * The Task Runner: finds what can be run in the workspace folders — package.json scripts, `.vscode/tasks.json` and
 * `.oneclient/tasks.json`, .NET solutions / projects — and runs a task as a background process tracked by the
 * TaskService (output, exit code, stop, run again).
 */
export class TaskRunner {
  private readonly running = new Map<string, { taskId: string; child: ChildProcess }>();
  private lastDefinitions = new Map<string, TaskDefinition>();

  constructor(
    private readonly tasks: TaskService,
    private readonly folders: () => Folder[],
  ) {}

  async detect(): Promise<TaskDefinition[]> {
    const all: TaskDefinition[] = [];
    for (const folder of this.folders()) {
      for (const [file, source] of [
        [join(folder.path, ".oneclient", "tasks.json"), "tasks.json"],
        [join(folder.path, ".vscode", "tasks.json"), "tasks.json"],
      ] as const) {
        all.push(...tasksFromJson(await readJson(file, true), folder, source));
      }
      const pkg = (await readJson(join(folder.path, "package.json"))) as { scripts?: Record<string, string> } | undefined;
      if (pkg?.scripts && typeof pkg.scripts === "object") {
        const pm = packageManager(folder.path);
        for (const [name, script] of Object.entries(pkg.scripts)) {
          if (typeof script !== "string") continue;
          const label = `${pm}: ${name}`;
          const group = /^(build|compile)\b/.test(name) ? "build" : /^test\b/.test(name) ? "test" : undefined;
          all.push({ id: `${folder.id}:${pm}:${name}`, label, source: pm, command: `${pm} run ${quote(name)}`, cwd: folder.path, folderId: folder.id, folderName: folder.name, detail: script, ...(group ? { group } : {}) });
        }
      }
      // .NET: a solution (or a single project) at the top of the folder.
      const entries = await readdir(folder.path).catch(() => [] as string[]);
      const target = entries.find((e) => e.endsWith(".sln") || e.endsWith(".slnx")) ?? entries.find((e) => /\.(cs|fs|vb)proj$/.test(e));
      if (target) {
        for (const [verb, group] of [["build", "build"], ["test", "test"], ["restore", undefined], ["clean", undefined]] as const) {
          all.push({
            id: `${folder.id}:dotnet:${verb}`,
            label: `dotnet: ${verb}`,
            source: "dotnet",
            command: `dotnet ${verb} ${quote(target)}`,
            cwd: folder.path,
            folderId: folder.id,
            folderName: folder.name,
            detail: target,
            ...(group ? { group } : {}),
          });
        }
      }
    }
    // De-duplicate (the same label in .oneclient and .vscode: the first wins).
    const seen = new Set<string>();
    const unique = all.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
    this.lastDefinitions = new Map(unique.map((d) => [d.id, d]));
    return unique;
  }

  /** Task ids of definitions currently running. */
  runningDefinitions(): Record<string, string> {
    return Object.fromEntries([...this.running].map(([defId, r]) => [defId, r.taskId]));
  }

  /** Starts a task (a running one with the same definition is stopped first — "restart"). Returns the task id. */
  async run(definitionId: string): Promise<string> {
    let def = this.lastDefinitions.get(definitionId);
    if (!def) def = (await this.detect()).find((d) => d.id === definitionId);
    if (!def) throw new Error("That task doesn't exist (any more).");
    const previous = this.running.get(def.id);
    if (previous) {
      this.tasks.cancel(previous.taskId);
      await new Promise((r) => setTimeout(r, 300));
    }
    return this.runCommand(def.label, def.source, def.command, def.cwd, def.id);
  }

  /** Runs any shell command as a tracked background task. */
  runCommand(title: string, source: string, command: string, cwd: string, definitionId?: string): string {
    let child: ChildProcess | null = null;
    const task = this.tasks.start({
      title,
      source,
      cancellable: true,
      command,
      cwd,
      ...(definitionId ? { definitionId } : {}),
      onCancel: () => child && killTree(child),
    });
    task.log(`> ${command}\n  (in ${cwd})\n\n`);
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        // Its own process group on POSIX, so Stop can end the whole tree.
        detached: process.platform !== "win32",
        env: { ...process.env, FORCE_COLOR: "1", CLICOLOR_FORCE: "1" },
      });
    } catch (err) {
      task.fail(err instanceof Error ? err.message : String(err));
      return task.id;
    }
    if (definitionId) this.running.set(definitionId, { taskId: task.id, child });
    child.stdout?.on("data", (d: Buffer) => task.log(d.toString("utf-8")));
    child.stderr?.on("data", (d: Buffer) => task.log(d.toString("utf-8")));
    child.on("error", (err) => task.fail(err.message));
    child.on("close", (code, signal) => {
      if (definitionId && this.running.get(definitionId)?.taskId === task.id) this.running.delete(definitionId);
      task.log(`\n${code === 0 ? "✓" : "✗"} exited with ${code ?? signal}\n`);
      if (task.isCancelled) task.cancelled();
      else if (code === 0) task.succeed(`Exited with 0`);
      else task.fail(`Exited with ${code ?? signal}`, code ?? undefined);
    });
    return task.id;
  }

  /** Stops every running task (app quit). */
  stopAll(): void {
    for (const { child } of this.running.values()) killTree(child);
  }
}

/** Ends a process and everything it started (a shell → npm → node…). */
function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}
