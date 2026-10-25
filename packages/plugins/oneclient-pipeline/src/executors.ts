import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusMatches } from "./assertions.js";
import type { ExecInput, ExecOutput, Executor } from "./engine.js";
import type { ContainerStep, HttpStep, ShellStep, ToolStep, WaitStep, SetStep } from "./model.js";
import { jsonPath, stringify } from "./vars.js";

/** Calls a command another plugin lists as an AI tool (`context.aiTools.call`). */
export type CallTool = (command: string, input: Record<string, unknown>) => Promise<unknown>;

const sleepAbortable = (ms: number, signal: AbortSignal) =>
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

export const waitExecutor: Executor = async ({ step, signal, log }: ExecInput) => {
  const { seconds } = step as WaitStep;
  log(`Waiting ${seconds}s…\n`);
  await sleepAbortable(Math.max(0, seconds) * 1000, signal);
  return {};
};

export const setExecutor: Executor = async ({ step, log }: ExecInput) => {
  const { values } = step as SetStep;
  for (const [k, v] of Object.entries(values)) log(`${k} = ${v}\n`);
  return { vars: { ...values } };
};

/** Nothing to do itself — the engine evaluates the step's assertions against the variables. */
export const assertExecutor: Executor = async () => ({});

// ---------------------------------------------------------------- shell

interface ShellCommand {
  file: string;
  args: (script: string) => string[];
  ext: string;
  wrap: (script: string) => string;
}

export function shellCommand(shell: NonNullable<ShellStep["shell"]>, platform: NodeJS.Platform = process.platform): ShellCommand {
  const resolved = shell === "auto" ? (platform === "win32" ? "powershell" : "bash") : shell;
  const ps = (file: string): ShellCommand => ({
    file,
    ext: ".ps1",
    args: (s) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", s],
    // A failing native command or cmdlet must fail the step: stop on errors and pass the last exit code on.
    wrap: (s) => `$ErrorActionPreference = 'Stop'\n${s}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\n`,
  });
  switch (resolved) {
    case "powershell":
      return ps(platform === "win32" ? "powershell.exe" : "pwsh");
    case "pwsh":
      return ps("pwsh");
    case "cmd":
      return { file: "cmd.exe", ext: ".cmd", args: (s) => ["/d", "/c", s], wrap: (s) => `@echo off\r\n${s}\r\n` };
    case "sh":
      return { file: "sh", ext: ".sh", args: (s) => [s], wrap: (s) => `set -e\n${s}\n` };
    default:
      return { file: "bash", ext: ".sh", args: (s) => [s], wrap: (s) => `set -e\n${s}\n` };
  }
}

/** `::set name=value` lines in a script's output become pipeline variables. */
export function parseSetLines(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const m = /^::set\s+([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export const shellExecutor: Executor = async ({ step, signal, log }: ExecInput) => {
  const s = step as ShellStep;
  const cmd = shellCommand(s.shell ?? "auto");
  const dir = mkdtempSync(join(tmpdir(), "oneclient-pipeline-"));
  const file = join(dir, `step${cmd.ext}`);
  writeFileSync(file, cmd.wrap(s.script), "utf8");
  try {
    return await new Promise<ExecOutput>((resolve) => {
      const child = spawn(cmd.file, cmd.args(file), { cwd: s.cwd || undefined, env: { ...process.env, ...(s.env ?? {}) }, windowsHide: true });
      let output = "";
      const take = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        output += text;
        log(text);
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const kill = () => {
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGTERM");
      };
      signal.addEventListener("abort", kill, { once: true });
      child.once("error", (err) => resolve({ error: `Could not start ${cmd.file}: ${err.message}` }));
      child.once("close", (code) => {
        signal.removeEventListener("abort", kill);
        const exitCode = code ?? -1;
        const trimmed = output.trim();
        const outputs: Record<string, string> = { exitCode: String(exitCode), output: trimmed };
        // A non-zero exit fails the step unless the step asserts on the exit code itself.
        resolve({
          subject: { exitCode, output: trimmed },
          outputs,
          vars: parseSetLines(output),
          ...(exitCode !== 0 && !(step.assertions ?? []).some((a) => a.target === "exitCode") ? { error: `Exited with code ${exitCode}.` } : {}),
        });
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------- http

export const DEFAULT_HTTP_TIMEOUT_SECONDS = 30;

export const httpExecutor: Executor = async ({ step, signal, log }: ExecInput) => {
  const s = step as HttpStep;
  const method = (s.method || "GET").toUpperCase();
  const headers = { ...(s.headers ?? {}) };
  const hasBody = s.body !== undefined && s.body !== "" && method !== "GET" && method !== "HEAD";
  if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = /^\s*[[{]/.test(s.body ?? "") ? "application/json" : "text/plain";
  }
  log(`${method} ${s.url}\n`);
  const started = Date.now();
  // A request nobody answers must not hang the pipeline (a container's published port accepts connections before the
  // server behind it is up): without a timeout of its own the step gets 30 seconds, then fails and can be retried.
  const limit = s.timeoutSeconds && s.timeoutSeconds > 0 ? s.timeoutSeconds : DEFAULT_HTTP_TIMEOUT_SECONDS;
  const guarded = AbortSignal.any([signal, AbortSignal.timeout(limit * 1000)]);
  let res: Response;
  try {
    res = await fetch(s.url, { method, headers, ...(hasBody ? { body: s.body } : {}), signal: guarded });
  } catch (err) {
    if (signal.aborted) throw err;
    if (guarded.aborted) return { error: `No answer from ${s.url} within ${limit}s.` };
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    return { error: `Request failed: ${cause ?? (err instanceof Error ? err.message : String(err))}` };
  }
  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    if (signal.aborted) throw err;
    return { error: guarded.aborted ? `The response from ${s.url} did not finish within ${limit}s.` : `Could not read the response: ${err instanceof Error ? err.message : String(err)}` };
  }
  const durationMs = Date.now() - started;
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (responseHeaders[k.toLowerCase()] = v));
  log(`← ${res.status} ${res.statusText} (${durationMs} ms, ${body.length} bytes)\n`);
  if (body) log(`${body.length > 2000 ? `${body.slice(0, 2000)}…` : body}\n`);

  const vars: Record<string, string> = {};
  let parsed: unknown;
  let parsedOk = false;
  for (const e of s.extract ?? []) {
    if (!e.name) continue;
    let value: string | undefined;
    if (e.from === "status") value = String(res.status);
    else if (e.from === "body") value = body;
    else if (e.from === "header") value = responseHeaders[(e.path ?? "").toLowerCase()];
    else {
      if (!parsedOk) {
        try {
          parsed = JSON.parse(body);
          parsedOk = true;
        } catch {
          return { error: `Cannot extract “${e.name}”: the response is not JSON.` };
        }
      }
      const found = e.path ? jsonPath(parsed, e.path) : parsed;
      value = found === undefined ? undefined : stringify(found);
    }
    if (value === undefined) return { error: `Cannot extract “${e.name}”: ${e.from} ${e.path ?? ""} is not in the response.` };
    vars[e.name] = value;
  }

  return {
    subject: { status: res.status, body, headers: responseHeaders, durationMs },
    outputs: { status: String(res.status), body, durationMs: String(durationMs) },
    vars,
    ...(statusMatches(res.status, s.expectStatus) ? {} : { error: `Expected status ${s.expectStatus ?? "2xx"}, got ${res.status}.` }),
  };
};

// ---------------------------------------------------------------- plugin commands

/** A command's result: `{ ok: false, error }` fails the step; anything else is output. */
function toolOutput(result: unknown): ExecOutput {
  if (result && typeof result === "object" && "ok" in result && (result as { ok: unknown }).ok === false) {
    return { error: String((result as { error?: unknown }).error ?? "The command failed.") };
  }
  const text = result && typeof result === "object" && typeof (result as { text?: unknown }).text === "string" ? (result as { text: string }).text : stringify(result);
  return { subject: { body: text, output: text }, outputs: { output: text, body: text } };
}

export const toolExecutor = (callTool: CallTool): Executor => async ({ step, log }) => {
  const s = step as ToolStep;
  let input: Record<string, unknown> = {};
  if (s.input?.trim()) {
    const parsed: unknown = JSON.parse(s.input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The input must be a JSON object.");
    input = parsed as Record<string, unknown>;
  }
  log(`${s.command}\n`);
  const out = toolOutput(await callTool(s.command, input));
  if (out.subject?.output) log(`${out.subject.output.length > 2000 ? `${out.subject.output.slice(0, 2000)}…` : out.subject.output}\n`);
  return out;
};

// ---------------------------------------------------------------- test containers (Docker plugin)

const RUN = "docker.runTestContainer";
const REMOVE = "docker.removeContainer";
const CLEANUP = "docker.cleanupTestContainers";

export const containerExecutor = (callTool: CallTool): Executor => async ({ step, log, onFinish }) => {
  const s = step as ContainerStep;
  if (s.action === "cleanup") {
    const r = (await callTool(CLEANUP, { connectionId: s.connectionId })) as { ok?: boolean; error?: string; message?: string };
    if (r?.ok === false) return { error: r.error ?? "Cleanup failed." };
    log(`${r?.message ?? "Removed the test containers."}\n`);
    return {};
  }
  if (s.action === "remove") {
    const r = (await callTool(REMOVE, { connectionId: s.connectionId, containerId: s.target })) as { ok?: boolean; error?: string };
    if (r?.ok === false) return { error: r.error ?? "Could not remove the container." };
    log(`Removed ${s.target}\n`);
    return {};
  }

  const wait = s.wait ?? { kind: "port" };
  const request = {
    image: s.image ?? "",
    name: s.containerName ?? "",
    ports: s.ports ?? [],
    env: s.env ?? "",
    cmd: s.cmd ?? "",
    wait: wait.kind === "log" ? { kind: "log", message: wait.message ?? "" } : { kind: wait.kind },
    timeoutSeconds: s.waitTimeoutSeconds ?? 60,
    // A safety net if oneClient closes before the run's own cleanup: the Docker plugin removes it after two hours.
    ttlMinutes: s.keep ? 0 : 120,
    autoRemove: false,
  };
  log(`Starting ${request.image}…\n`);
  const r = (await callTool(RUN, { connectionId: s.connectionId, request })) as {
    ok?: boolean;
    error?: string;
    containerId?: string;
    name?: string;
    endpoints?: Record<string, string>;
    message?: string;
  };
  if (!r || r.ok === false) return { error: r?.error ?? "The Docker plugin did not start the container." };
  log(`${r.message ?? "Started."}\n`);

  const outputs: Record<string, string> = { containerId: r.containerId ?? "", name: r.name ?? "" };
  const endpoints = Object.entries(r.endpoints ?? {});
  for (const [i, [containerPort, endpoint]] of endpoints.entries()) {
    const n = containerPort.split("/")[0]!;
    const lastColon = endpoint.lastIndexOf(":");
    outputs[`endpoint.${n}`] = endpoint;
    outputs[`port.${n}`] = endpoint.slice(lastColon + 1);
    outputs[`host.${n}`] = endpoint.slice(0, lastColon);
    if (i === 0) {
      outputs.endpoint = endpoint;
      outputs.port = endpoint.slice(lastColon + 1);
      outputs.host = endpoint.slice(0, lastColon);
    }
  }
  if (!s.keep && r.containerId) {
    onFinish(`container ${r.name ?? r.containerId.slice(0, 12)}`, async () => {
      const rm = (await callTool(REMOVE, { connectionId: s.connectionId, containerId: r.containerId })) as { ok?: boolean; error?: string };
      if (rm?.ok === false) throw new Error(rm.error ?? "remove failed");
    });
  }
  return { outputs };
};
