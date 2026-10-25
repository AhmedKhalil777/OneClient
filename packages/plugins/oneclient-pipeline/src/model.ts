/**
 * A pipeline is an ordered list of steps run top to bottom, like a CI job: a step that fails stops the pipeline,
 * unless it is marked `continueOnError`; steps with `when: "always"` (teardown) run regardless. Everything in this
 * module is plain data so pipelines can be stored, exported and edited as JSON.
 */
export const STORE_VERSION = 1;

export type StepKind = "shell" | "container" | "http" | "tool" | "wait" | "set" | "assert";
export type StepCondition = "success" | "failure" | "always";

export type AssertTarget = "status" | "body" | "json" | "header" | "duration" | "exitCode" | "output" | "var";
export type AssertOp = "equals" | "notEquals" | "contains" | "notContains" | "matches" | "gt" | "lt" | "exists" | "notExists";

export interface Assertion {
  target: AssertTarget;
  /** JSON path for `json` (`data.items[0].id`), header name for `header`, variable name for `var`. */
  path?: string;
  op: AssertOp;
  value?: string;
}

export interface StepBase {
  /** Unique within the pipeline; how later steps refer to this one: `{{steps.<id>.<output>}}`. Letters, digits, `_`, `-`. */
  id: string;
  name: string;
  kind: StepKind;
  enabled?: boolean;
  /** `success` (default): run while nothing has failed. `failure`: only after a failure. `always`: teardown. */
  when?: StepCondition;
  /** A failure here is recorded but does not fail the pipeline. */
  continueOnError?: boolean;
  /** Extra attempts after a failure (polling / flaky startups). */
  retries?: number;
  retryDelaySeconds?: number;
  timeoutSeconds?: number;
  assertions?: Assertion[];
}

export interface ShellStep extends StepBase {
  kind: "shell";
  shell?: "auto" | "powershell" | "pwsh" | "bash" | "sh" | "cmd";
  script: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ContainerStep extends StepBase {
  kind: "container";
  action: "run" | "remove" | "cleanup";
  /** The Docker connection to use. */
  connectionId: string;
  image?: string;
  containerName?: string;
  /** `8080`, `9090:8080`, `53/udp` — one per entry. */
  ports?: string[];
  /** `KEY=VALUE` per line. */
  env?: string;
  cmd?: string;
  wait?: { kind: "none" | "port" | "log" | "healthy"; message?: string };
  waitTimeoutSeconds?: number;
  /** Leave it running when the pipeline ends (default: removed at the end of the run). */
  keep?: boolean;
  /** For `remove`: container name or id. */
  target?: string;
}

export interface HttpStep extends StepBase {
  kind: "http";
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Status codes that count as success: `2xx`, `200,201`, `any`. Default `2xx`. */
  expectStatus?: string;
  /** Values to keep from the response as variables: `from` is `json`, `header`, `status` or `body`. */
  extract?: Array<{ name: string; from: "json" | "header" | "status" | "body"; path?: string }>;
}

/** Calls a command another plugin lists as an AI tool (`oneclient.aiTools`) — the generic bridge to other plugins. */
export interface ToolStep extends StepBase {
  kind: "tool";
  command: string;
  /** JSON object text; may contain `{{…}}`. */
  input?: string;
}

export interface WaitStep extends StepBase {
  kind: "wait";
  seconds: number;
}

export interface SetStep extends StepBase {
  kind: "set";
  values: Record<string, string>;
}

export interface AssertStep extends StepBase {
  kind: "assert";
}

export type Step = ShellStep | ContainerStep | HttpStep | ToolStep | WaitStep | SetStep | AssertStep;

export interface PipelineVariable {
  name: string;
  value: string;
  /** Masked in logs; the value is kept in the secret store, not in the pipeline file. */
  secret?: boolean;
  /** Set by the plugin when a secret value is stored (the value itself is never sent back to the editor). */
  secretSet?: boolean;
}

export interface Pipeline {
  id: string;
  name: string;
  description?: string;
  variables: PipelineVariable[];
  steps: Step[];
  updatedAt: number;
}

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "ignored" | "cancelled";

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  /** What was found / why it failed. */
  message: string;
}

export interface StepResult {
  stepId: string;
  name: string;
  status: StepStatus;
  attempts: number;
  durationMs: number;
  error?: string;
  assertions: AssertionResult[];
  log: string;
  outputs: Record<string, string>;
}

export interface RunResult {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  startedAt: number;
  durationMs: number;
  status: "passed" | "failed" | "cancelled";
  steps: StepResult[];
}

/** Progress of a run, as it happens. */
export type RunEvent =
  | { type: "runStart"; runId: string; pipelineId: string; pipelineName: string; startedAt: number; steps: Array<{ stepId: string; name: string; kind: StepKind; skipped: boolean }> }
  | { type: "stepStart"; runId: string; index: number; stepId: string; name: string; attempt: number }
  | { type: "stepLog"; runId: string; index: number; text: string }
  | { type: "stepEnd"; runId: string; index: number; result: StepResult }
  | { type: "runEnd"; runId: string; result: RunResult };

const ID = /^[A-Za-z0-9_-]+$/;

/** Problems that make a pipeline impossible to run, in plain words. Empty = fine. */
export function validatePipeline(p: Pipeline): string[] {
  const problems: string[] = [];
  if (!p.name.trim()) problems.push("The pipeline needs a name.");
  const seen = new Set<string>();
  for (const [i, s] of p.steps.entries()) {
    const label = `Step ${i + 1}${s.name ? ` “${s.name}”` : ""}`;
    if (!ID.test(s.id)) problems.push(`${label}: the id may only use letters, digits, '_' and '-'.`);
    else if (seen.has(s.id)) problems.push(`${label}: the id “${s.id}” is used twice.`);
    seen.add(s.id);
    if (s.kind === "shell" && !s.script.trim()) problems.push(`${label}: the script is empty.`);
    if (s.kind === "http" && !s.url.trim()) problems.push(`${label}: the URL is empty.`);
    if (s.kind === "tool" && !s.command.trim()) problems.push(`${label}: choose a command.`);
    if (s.kind === "container") {
      if (!s.connectionId) problems.push(`${label}: choose a Docker connection.`);
      if (s.action === "run" && !s.image?.trim()) problems.push(`${label}: the image is empty.`);
      if (s.action === "remove" && !s.target?.trim()) problems.push(`${label}: say which container to remove.`);
    }
    if (s.kind === "tool" && s.input?.trim()) {
      // `{{…}}` placeholders are not valid JSON on their own, but they sit inside strings, so the text still parses.
      try {
        JSON.parse(s.input);
      } catch {
        problems.push(`${label}: the input is not valid JSON.`);
      }
    }
  }
  const names = new Set<string>();
  for (const v of p.variables) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(v.name)) problems.push(`Variable “${v.name}”: use letters, digits, '_', '.' and '-'.`);
    if (names.has(v.name)) problems.push(`Variable “${v.name}” is defined twice.`);
    names.add(v.name);
  }
  return problems;
}

/** Fills in anything missing so older / hand-edited files still load. */
export function normalizePipeline(raw: unknown): Pipeline {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const steps = Array.isArray(r.steps) ? (r.steps as Step[]).filter((s) => s && typeof s === "object" && typeof s.kind === "string") : [];
  return {
    id: typeof r.id === "string" && r.id ? r.id : "",
    name: typeof r.name === "string" ? r.name : "Untitled pipeline",
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    variables: Array.isArray(r.variables) ? (r.variables as PipelineVariable[]).filter((v) => v && typeof v.name === "string").map((v) => ({ ...v, value: typeof v.value === "string" ? v.value : "" })) : [],
    steps: steps.map((s, i) => ({ ...s, id: typeof s.id === "string" && s.id ? s.id : `step${i + 1}`, name: typeof s.name === "string" ? s.name : `Step ${i + 1}` })),
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : Date.now(),
  };
}

/** A new step of a kind with sensible defaults, id unique among `existing`. */
export function newStep(kind: StepKind, existing: Step[]): Step {
  const ids = new Set(existing.map((s) => s.id));
  let n = existing.length + 1;
  while (ids.has(`${kind}${n}`)) n++;
  const base = { id: `${kind}${n}`, name: STEP_TITLES[kind] };
  switch (kind) {
    case "shell":
      return { ...base, kind, shell: "auto", script: "" };
    case "container":
      return { ...base, kind, action: "run", connectionId: "", image: "", ports: [], wait: { kind: "port" }, waitTimeoutSeconds: 60 };
    case "http":
      return { ...base, kind, method: "GET", url: "", expectStatus: "2xx", assertions: [] };
    case "tool":
      return { ...base, kind, command: "", input: "{}" };
    case "wait":
      return { ...base, kind, seconds: 5 };
    case "set":
      return { ...base, kind, values: {} };
    case "assert":
      return { ...base, kind, assertions: [{ target: "var", path: "", op: "equals", value: "" }] };
  }
}

export const STEP_TITLES: Record<StepKind, string> = {
  shell: "Run script",
  container: "Test container",
  http: "HTTP request",
  tool: "Plugin command",
  wait: "Wait",
  set: "Set variables",
  assert: "Check values",
};
