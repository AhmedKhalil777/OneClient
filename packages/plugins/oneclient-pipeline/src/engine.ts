import { evaluateAll, type Subject } from "./assertions.js";
import type { Pipeline, RunEvent, RunResult, Step, StepKind, StepResult } from "./model.js";

export type { RunEvent };
import { deepInterpolate, mask, UndefinedVariable, type Vars } from "./vars.js";

/** What an executor gets: the step with every `{{…}}` already resolved. */
export interface ExecInput<S extends Step = Step> {
  step: S;
  vars: Vars;
  signal: AbortSignal;
  log(text: string): void;
  /** Registers teardown that runs after the last step (reverse order), e.g. removing a container this step started. */
  onFinish(label: string, fn: () => Promise<void>): void;
}

export interface ExecOutput {
  /** What assertions can look at. */
  subject?: Omit<Subject, "vars">;
  /** Reachable by later steps as `{{steps.<id>.<key>}}`. */
  outputs?: Record<string, string>;
  /** Set globally, as `{{<name>}}`. */
  vars?: Vars;
  /** Fails the step. */
  error?: string;
}

export type Executor = (input: ExecInput) => Promise<ExecOutput>;

export interface EngineOptions {
  runId: string;
  executors: Partial<Record<StepKind, Executor>>;
  /** Starting variables (pipeline variables and per-run overrides). */
  vars: Vars;
  /** Values to hide in logs and errors. */
  secrets?: string[];
  signal: AbortSignal;
  onEvent?: (event: RunEvent) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs a pipeline. Rules, in CI terms: steps run in order; a failed step fails the run and skips the steps after it,
 * except `when: "always"` (teardown) and `when: "failure"` steps; `continueOnError` records a failure without failing
 * the run; `retries` re-run a failing step; cancelling stops the current step and still runs `always` steps.
 */
export async function runPipeline(pipeline: Pipeline, options: EngineOptions): Promise<RunResult> {
  const sleep = options.sleep ?? defaultSleep;
  const secrets = options.secrets ?? [];
  const emit = (e: RunEvent) => options.onEvent?.(e);
  const vars: Vars = { ...options.vars };
  const startedAt = Date.now();
  const results: StepResult[] = [];
  const finishers: Array<{ label: string; fn: () => Promise<void> }> = [];
  let failed = false;
  const cancelled = () => options.signal.aborted;

  emit({
    type: "runStart",
    runId: options.runId,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    startedAt,
    steps: pipeline.steps.map((s) => ({ stepId: s.id, name: s.name, kind: s.kind, skipped: s.enabled === false })),
  });

  for (const [index, step] of pipeline.steps.entries()) {
    const result: StepResult = { stepId: step.id, name: step.name, status: "pending", attempts: 0, durationMs: 0, assertions: [], log: "", outputs: {} };
    results.push(result);

    const when = step.when ?? "success";
    const wanted = step.enabled === false ? false : when === "always" ? true : when === "failure" ? failed || cancelled() : !failed && !cancelled();
    if (!wanted) {
      result.status = step.enabled !== false && cancelled() && when === "success" ? "cancelled" : "skipped";
      emit({ type: "stepEnd", runId: options.runId, index, result });
      continue;
    }

    const started = Date.now();
    const log = (text: string) => {
      const clean = mask(text, secrets);
      result.log += clean;
      emit({ type: "stepLog", runId: options.runId, index, text: clean });
    };
    const maxAttempts = 1 + Math.max(0, Math.floor(step.retries ?? 0));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      result.attempts = attempt;
      result.error = undefined as never;
      result.assertions = [];
      result.status = "running";
      emit({ type: "stepStart", runId: options.runId, index, stepId: step.id, name: step.name, attempt });
      if (attempt > 1) log(`\n— attempt ${attempt} of ${maxAttempts} —\n`);

      // `always` steps still run after a cancel, with a signal that is not aborted.
      const stepSignal = when === "always" && cancelled() ? new AbortController().signal : options.signal;
      const timeout = new AbortController();
      const timer = step.timeoutSeconds && step.timeoutSeconds > 0 ? setTimeout(() => timeout.abort(), step.timeoutSeconds * 1000) : undefined;
      const signal = AbortSignal.any([stepSignal, timeout.signal]);

      try {
        const executor = options.executors[step.kind];
        if (!executor) throw new Error(`No executor for “${step.kind}” steps.`);
        const resolved = deepInterpolate(step, vars);
        const out = await executor({
          step: resolved,
          vars,
          signal,
          log,
          onFinish: (label, fn) => finishers.push({ label: `${step.name}: ${label}`, fn }),
        });
        if (timeout.signal.aborted) throw new Error(`Timed out after ${step.timeoutSeconds}s.`);
        if (stepSignal.aborted) throw new Error("Stopped.");

        for (const [k, v] of Object.entries(out.outputs ?? {})) {
          result.outputs[k] = v;
          vars[`steps.${step.id}.${k}`] = v;
        }
        Object.assign(vars, out.vars ?? {});
        // The step's own outputs and variables are available to its assertions.
        result.assertions = evaluateAll(resolved.assertions, { ...out.subject, vars });
        if (out.error) throw new Error(out.error);
        const bad = result.assertions.filter((a) => !a.passed);
        if (bad.length) throw new Error(bad.map((b) => b.message).join("\n"));
        result.status = "passed";
      } catch (err) {
        result.status = cancelled() && when !== "always" ? "cancelled" : "failed";
        const message = timeout.signal.aborted ? `Timed out after ${step.timeoutSeconds}s.` : err instanceof UndefinedVariable ? err.message : errorText(err);
        result.error = mask(message, secrets);
      } finally {
        if (timer) clearTimeout(timer);
      }

      result.durationMs = Date.now() - started;
      if (result.status === "passed" || result.status === "cancelled" || attempt === maxAttempts) break;
      log(`✗ ${result.error}\n`);
      await sleep(Math.max(0, step.retryDelaySeconds ?? 2) * 1000, options.signal);
      if (cancelled()) {
        result.status = "cancelled";
        break;
      }
    }

    if (result.status === "failed") {
      if (step.continueOnError) result.status = "ignored";
      else failed = true;
    }
    if (result.error) log(`${result.status === "cancelled" ? "■" : "✗"} ${result.error}\n`);
    emit({ type: "stepEnd", runId: options.runId, index, result });
  }

  if (finishers.length) {
    const index = results.length;
    const cleanup: StepResult = { stepId: "_cleanup", name: "Clean up", status: "running", attempts: 1, durationMs: 0, assertions: [], log: "", outputs: {} };
    results.push(cleanup);
    const started = Date.now();
    emit({ type: "stepStart", runId: options.runId, index, stepId: cleanup.stepId, name: cleanup.name, attempt: 1 });
    const say = (text: string) => {
      cleanup.log += text;
      emit({ type: "stepLog", runId: options.runId, index, text });
    };
    for (const f of finishers.reverse()) {
      try {
        await f.fn();
        say(`removed ${f.label}\n`);
      } catch (err) {
        say(`could not clean up ${f.label}: ${errorText(err)}\n`);
      }
    }
    cleanup.status = "passed";
    cleanup.durationMs = Date.now() - started;
    emit({ type: "stepEnd", runId: options.runId, index, result: cleanup });
  }

  const result: RunResult = {
    runId: options.runId,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    startedAt,
    durationMs: Date.now() - startedAt,
    status: cancelled() ? "cancelled" : failed ? "failed" : "passed",
    steps: results,
  };
  emit({ type: "runEnd", runId: options.runId, result });
  return result;
}
