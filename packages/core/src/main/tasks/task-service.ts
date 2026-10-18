import { randomUUID } from "node:crypto";

export type TaskState = "running" | "succeeded" | "failed" | "cancelled";

/** A background task as the shell shows it (Tasks panel, status bar). */
export interface TaskInfo {
  id: string;
  title: string;
  /** Who runs it: "Git", "npm", "dotnet", a plugin's name… */
  source: string;
  state: TaskState;
  /** Latest progress message ("Receiving objects: 45%"). */
  detail?: string;
  /** 0..1 when known. */
  progress?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  cancellable: boolean;
  /** Process tasks: what runs, and where. */
  command?: string;
  cwd?: string;
  /** Set when the task can be started again (Task Runner definitions). */
  definitionId?: string;
}

export interface TaskHandle {
  readonly id: string;
  /** Append to the task's output. */
  log(text: string): void;
  report(update: { detail?: string; progress?: number }): void;
  succeed(detail?: string): void;
  fail(error: string, exitCode?: number): void;
  /** Ended because the user cancelled it. */
  cancelled(): void;
  readonly isCancelled: boolean;
}

export interface StartTaskOptions {
  title: string;
  source: string;
  cancellable?: boolean;
  /** Called when the user cancels; the task should stop and call `cancelled()`. */
  onCancel?: () => void;
  command?: string;
  cwd?: string;
  definitionId?: string;
}

const MAX_TASKS = 60;
const MAX_OUTPUT = 1_000_000;

interface Entry {
  info: TaskInfo;
  output: string;
  onCancel?: (() => void) | undefined;
  cancelRequested: boolean;
}

/**
 * Background tasks: anything long-running that the user should be able to see, follow and stop — Git fetch / pull /
 * push, Task Runner processes (npm scripts, builds), and plugins' own work (`context.tasks.run`). Keeps the last
 * tasks with their output; finished ones can be cleared.
 */
export class TaskService {
  private readonly tasks = new Map<string, Entry>();
  private readonly changeListeners = new Set<(tasks: TaskInfo[]) => void>();
  private readonly outputListeners = new Set<(id: string, chunk: string) => void>();
  private notifyTimer: NodeJS.Timeout | null = null;

  start(opts: StartTaskOptions): TaskHandle {
    const id = randomUUID();
    const entry: Entry = {
      info: {
        id,
        title: opts.title,
        source: opts.source,
        state: "running",
        startedAt: Date.now(),
        cancellable: Boolean(opts.cancellable),
        ...(opts.command ? { command: opts.command } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.definitionId ? { definitionId: opts.definitionId } : {}),
      },
      output: "",
      onCancel: opts.onCancel,
      cancelRequested: false,
    };
    this.tasks.set(id, entry);
    this.prune();
    this.changed(true);

    const end = (state: TaskState, patch: Partial<TaskInfo> = {}) => {
      if (entry.info.state !== "running") return;
      entry.info = { ...entry.info, ...patch, state, endedAt: Date.now() };
      if (state === "succeeded") entry.info.progress = 1;
      this.changed(true);
    };
    return {
      id,
      log: (text) => {
        if (!text) return;
        entry.output += text;
        if (entry.output.length > MAX_OUTPUT) entry.output = `… (earlier output trimmed)\n${entry.output.slice(-MAX_OUTPUT * 0.8)}`;
        for (const l of this.outputListeners) l(id, text);
      },
      report: ({ detail, progress }) => {
        if (entry.info.state !== "running") return;
        entry.info = { ...entry.info, ...(detail !== undefined ? { detail } : {}), ...(progress !== undefined ? { progress: Math.max(0, Math.min(1, progress)) } : {}) };
        this.changed(false);
      },
      succeed: (detail) => end(entry.cancelRequested ? "cancelled" : "succeeded", detail ? { detail } : {}),
      fail: (error, exitCode) => end(entry.cancelRequested ? "cancelled" : "failed", { detail: error, ...(exitCode !== undefined ? { exitCode } : {}) }),
      cancelled: () => end("cancelled", { detail: "Cancelled" }),
      get isCancelled() {
        return entry.cancelRequested;
      },
    };
  }

  /** Runs `work` as a task: its result ends the task (a throw fails it). */
  async run<T>(opts: StartTaskOptions, work: (task: TaskHandle) => Promise<T>): Promise<T> {
    const task = this.start(opts);
    try {
      const result = await work(task);
      task.succeed();
      return result;
    } catch (err) {
      task.fail(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  list(): TaskInfo[] {
    return [...this.tasks.values()].map((e) => ({ ...e.info })).sort((a, b) => b.startedAt - a.startedAt);
  }

  output(id: string): string {
    return this.tasks.get(id)?.output ?? "";
  }

  cancel(id: string): boolean {
    const e = this.tasks.get(id);
    if (!e || e.info.state !== "running" || !e.info.cancellable) return false;
    e.cancelRequested = true;
    e.info = { ...e.info, detail: "Cancelling…" };
    this.changed(true);
    try {
      e.onCancel?.();
    } catch {
      /* the task will still be marked when it ends */
    }
    return true;
  }

  /** Forget finished tasks. */
  clearFinished(): void {
    for (const [id, e] of this.tasks) if (e.info.state !== "running") this.tasks.delete(id);
    this.changed(true);
  }

  onChanged(listener: (tasks: TaskInfo[]) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onOutput(listener: (id: string, chunk: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  private prune(): void {
    if (this.tasks.size <= MAX_TASKS) return;
    const finished = [...this.tasks.values()].filter((e) => e.info.state !== "running").sort((a, b) => a.info.startedAt - b.info.startedAt);
    for (const e of finished.slice(0, this.tasks.size - MAX_TASKS)) this.tasks.delete(e.info.id);
  }

  /** State changes go out at once; progress updates are batched (a chatty task mustn't flood the IPC). */
  private changed(now: boolean): void {
    if (now) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
      const list = this.list();
      for (const l of this.changeListeners) l(list);
      return;
    }
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => this.changed(true), 150);
  }
}
