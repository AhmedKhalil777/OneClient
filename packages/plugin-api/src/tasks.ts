import type { Disposable } from "./context.js";

/**
 * Background tasks: long-running work the user should see and be able to stop — shown in the status bar and the
 * Tasks panel next to core's own (Git fetch / push, Task Runner builds).
 *
 * ```ts
 * await context.tasks.run({ title: "Import 2,000 rows", cancellable: true }, async (task) => {
 *   for (const [i, batch] of batches.entries()) {
 *     if (task.isCancelled) return;
 *     task.report({ detail: `Batch ${i + 1}/${batches.length}`, progress: i / batches.length });
 *     task.log(`inserted ${await insert(batch)} rows\n`);
 *   }
 * });
 * ```
 */
export interface TaskOptions {
  title: string;
  /** Show a Stop button; check `task.isCancelled` / `task.onCancel`. */
  cancellable?: boolean;
}

export interface Task {
  /** Append to the task's output (shown in the Tasks panel). */
  log(text: string): void;
  /** Progress message and/or fraction (0..1). */
  report(update: { detail?: string; progress?: number }): void;
  readonly isCancelled: boolean;
  /** Called when the user stops the task. */
  onCancel(listener: () => void): Disposable;
}

export interface Tasks {
  /** Runs `work` as a background task. Resolving ends it successfully; throwing marks it failed (and rethrows). */
  run<T>(options: TaskOptions, work: (task: Task) => Promise<T>): Promise<T>;
}
