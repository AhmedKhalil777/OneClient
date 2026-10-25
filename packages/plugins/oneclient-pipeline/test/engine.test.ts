import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { evaluate, statusMatches } from "../src/assertions.js";
import { type Executor, type RunEvent, runPipeline } from "../src/engine.js";
import { containerExecutor, httpExecutor, parseSetLines, shellCommand, toolExecutor } from "../src/executors.js";
import { newStep, normalizePipeline, type Pipeline, type Step, validatePipeline } from "../src/model.js";
import { deepInterpolate, interpolate, jsonPath, mask } from "../src/vars.js";

const pipeline = (steps: Step[], variables: Pipeline["variables"] = []): Pipeline => ({ id: "p", name: "P", variables, steps, updatedAt: 0 });
const step = (over: Partial<Step> & { id: string }): Step => ({ name: over.id, kind: "wait", seconds: 0, ...over }) as Step;
const noSleep = async () => undefined;

function run(p: Pipeline, executors: Record<string, Executor>, extra: { vars?: Record<string, string>; signal?: AbortSignal; secrets?: string[] } = {}) {
  const events: RunEvent[] = [];
  const signal = extra.signal ?? new AbortController().signal;
  const result = runPipeline(p, { runId: "r", executors, vars: extra.vars ?? {}, signal, sleep: noSleep, onEvent: (e) => events.push(e), ...(extra.secrets ? { secrets: extra.secrets } : {}) });
  return { result, events };
}

describe("variables", () => {
  it("interpolates, with fallbacks and built-ins", () => {
    expect(interpolate("a {{x}} b {{ y:-fallback }} {{steps.db.port.5432}}", { x: "1", "steps.db.port.5432": "49153" })).toBe("a 1 b fallback 49153");
    expect(interpolate("{{$guid}}", {})).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("fails on an undefined variable but leaves shell syntax alone", () => {
    expect(() => interpolate("{{nope}}", {})).toThrow(/Undefined variable {{nope}}/);
    expect(interpolate("echo ${HOME} $(date) ${env:PATH}", {})).toBe("echo ${HOME} $(date) ${env:PATH}");
  });
  it("walks objects and masks secrets", () => {
    expect(deepInterpolate({ a: ["{{x}}"], b: { c: "{{x}}!" }, n: 3 }, { x: "v" })).toEqual({ a: ["v"], b: { c: "v!" }, n: 3 });
    expect(mask("pw=hunter2 ok", ["hunter2"])).toBe("pw=*** ok");
  });
  it("reads JSON paths", () => {
    const d = { data: { items: [{ id: 7 }] } };
    expect(jsonPath(d, "data.items[0].id")).toBe(7);
    expect(jsonPath(d, "$.data.items[1].id")).toBeUndefined();
  });
});

describe("assertions", () => {
  const s = { status: 201, body: '{"user":{"name":"Ann","tags":["a","b"]}}', headers: { "content-type": "application/json" }, durationMs: 40, vars: { v: "x" } };
  it("checks every target", () => {
    expect(evaluate({ target: "status", op: "equals", value: "201" }, s).passed).toBe(true);
    expect(evaluate({ target: "json", path: "user.name", op: "equals", value: "Ann" }, s).passed).toBe(true);
    expect(evaluate({ target: "json", path: "user.tags[1]", op: "equals", value: "b" }, s).passed).toBe(true);
    expect(evaluate({ target: "json", path: "user.age", op: "exists" }, s).passed).toBe(false);
    expect(evaluate({ target: "header", path: "Content-Type", op: "contains", value: "json" }, s).passed).toBe(true);
    expect(evaluate({ target: "duration", op: "lt", value: "100" }, s).passed).toBe(true);
    expect(evaluate({ target: "body", op: "matches", value: "^\\{.*Ann" }, s).passed).toBe(true);
    expect(evaluate({ target: "var", path: "v", op: "notEquals", value: "y" }, s).passed).toBe(true);
  });
  it("says what it found when it fails", () => {
    expect(evaluate({ target: "status", op: "equals", value: "200" }, s).message).toContain('found "201"');
    expect(evaluate({ target: "body", op: "matches", value: "(" }, s).message).toContain("invalid pattern");
  });
  it("matches status specs", () => {
    expect(statusMatches(204, "2xx")).toBe(true);
    expect(statusMatches(404, "200,404")).toBe(true);
    expect(statusMatches(301, "200-299")).toBe(false);
    expect(statusMatches(500, "any")).toBe(true);
  });
});

describe("engine", () => {
  const ok: Executor = async () => ({});
  const boom: Executor = async () => ({ error: "boom" });

  it("runs in order and passes outputs on", async () => {
    const seen: string[] = [];
    const { result } = run(
      pipeline([step({ id: "a", kind: "set" } as Step), step({ id: "b" })]),
      {
        set: async () => ({ outputs: { thing: "42" }, vars: { shared: "yes" } }),
        wait: async ({ vars }) => {
          seen.push(vars["steps.a.thing"]!, vars.shared!);
          return {};
        },
      },
    );
    expect((await result).status).toBe("passed");
    expect(seen).toEqual(["42", "yes"]);
  });

  it("skips after a failure but runs teardown and failure steps", async () => {
    const ran: string[] = [];
    const track: Executor = async ({ step: s }) => (ran.push(s.id), s.id === "bad" ? { error: "no" } : {});
    const { result } = run(
      pipeline([step({ id: "bad" }), step({ id: "next" }), step({ id: "clean", when: "always" }), step({ id: "onfail", when: "failure" })]),
      { wait: track },
    );
    const r = await result;
    expect(ran).toEqual(["bad", "clean", "onfail"]);
    expect(r.status).toBe("failed");
    expect(r.steps.map((s) => s.status)).toEqual(["failed", "skipped", "passed", "passed"]);
  });

  it("continueOnError records the failure without failing the run", async () => {
    const { result } = run(pipeline([step({ id: "a", continueOnError: true }), step({ id: "b" })]), { wait: async ({ step: s }) => (s.id === "a" ? { error: "meh" } : {}) });
    const r = await result;
    expect(r.status).toBe("passed");
    expect(r.steps[0]!.status).toBe("ignored");
  });

  it("retries a failing step", async () => {
    let n = 0;
    const { result } = run(pipeline([step({ id: "a", retries: 2 })]), { wait: async () => (++n < 3 ? { error: "not yet" } : {}) });
    const r = await result;
    expect(r.status).toBe("passed");
    expect(r.steps[0]!.attempts).toBe(3);
    const failing = run(pipeline([step({ id: "a", retries: 1 })]), { wait: boom });
    expect((await failing.result).steps[0]!.attempts).toBe(2);
  });

  it("fails on assertions and reports them", async () => {
    const { result } = run(pipeline([step({ id: "a", assertions: [{ target: "status", op: "equals", value: "200" }] })]), { wait: async () => ({ subject: { status: 500 } }) });
    const r = await result;
    expect(r.status).toBe("failed");
    expect(r.steps[0]!.assertions[0]!.passed).toBe(false);
    expect(r.steps[0]!.error).toContain("found");
  });

  it("resolves variables in a step and fails clearly when one is missing", async () => {
    let got = "";
    const { result } = run(pipeline([step({ id: "a", kind: "http", url: "http://{{host}}/", method: "GET" } as Step)]), { http: async ({ step: s }) => ((got = (s as { url: string }).url), {}) }, { vars: { host: "h:1" } });
    await result;
    expect(got).toBe("http://h:1/");
    const missing = await run(pipeline([step({ id: "a", kind: "http", url: "{{nope}}", method: "GET" } as Step)]), { http: ok }).result;
    expect(missing.steps[0]!.error).toBe("Undefined variable {{nope}}.");
  });

  it("times out a step", async () => {
    const slow: Executor = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const r = await run(pipeline([step({ id: "a", timeoutSeconds: 0.02 })]), { wait: slow }).result;
    expect(r.steps[0]!.error).toBe("Timed out after 0.02s.");
  });

  it("cancels: stops the step, skips the rest, still runs teardown", async () => {
    const abort = new AbortController();
    const ran: string[] = [];
    const exec: Executor = async ({ step: s, signal }) => {
      ran.push(s.id);
      if (s.id === "a") {
        abort.abort();
        await new Promise((r) => setTimeout(r, 5));
        if (signal.aborted) throw new Error("stopped");
      }
      return {};
    };
    const r = await run(pipeline([step({ id: "a" }), step({ id: "b" }), step({ id: "clean", when: "always" })]), { wait: exec }, { signal: abort.signal }).result;
    expect(ran).toEqual(["a", "clean"]);
    expect(r.status).toBe("cancelled");
    expect(r.steps.map((s) => s.status)).toEqual(["cancelled", "cancelled", "passed"]);
  });

  it("runs finishers in reverse order after the steps and masks secrets in logs", async () => {
    const order: string[] = [];
    const exec: Executor = async ({ step: s, onFinish, log }) => {
      onFinish("thing", async () => void order.push(`rm ${s.id}`));
      log("token=s3cret\n");
      return {};
    };
    const { result, events } = run(pipeline([step({ id: "a" }), step({ id: "b" })]), { wait: exec }, { secrets: ["s3cret"] });
    const r = await result;
    expect(order).toEqual(["rm b", "rm a"]);
    expect(r.steps.at(-1)!.stepId).toBe("_cleanup");
    expect(r.steps[0]!.log).toBe("token=***\n");
    expect(events.at(-1)!.type).toBe("runEnd");
  });
});

describe("model", () => {
  it("validates", () => {
    const p = pipeline([newStep("shell", []), { ...newStep("wait", []), id: "bad id" }, newStep("container", [])]);
    const problems = validatePipeline(p);
    expect(problems.join("\n")).toMatch(/script is empty/);
    expect(problems.join("\n")).toMatch(/letters, digits/);
    expect(problems.join("\n")).toMatch(/Docker connection/);
  });
  it("normalizes sparse input and makes unique ids", () => {
    const p = normalizePipeline({ name: "X", steps: [{ kind: "wait", seconds: 1 }, { kind: "wait" }, "junk"] });
    expect(p.steps.map((s) => s.id)).toEqual(["step1", "step2"]);
    expect(newStep("http", p.steps).id).toBe("http3");
  });
});

describe("executors", () => {
  it("picks shells per platform", () => {
    expect(shellCommand("auto", "win32").file).toBe("powershell.exe");
    expect(shellCommand("auto", "linux").file).toBe("bash");
    expect(shellCommand("cmd").ext).toBe(".cmd");
    expect(shellCommand("powershell", "win32").wrap("x")).toContain("$ErrorActionPreference = 'Stop'");
  });
  it("parses ::set lines", () => {
    expect(parseSetLines("hi\n::set id=42\n  ::set url=http://x/?a=b\n::bogus x=1")).toEqual({ id: "42", url: "http://x/?a=b" });
  });

  it("http: status, JSON assertions and extraction against a real server", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.statusCode = req.url === "/missing" ? 404 : 200;
      res.end(JSON.stringify({ id: 9, echo: req.method }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const good = await run(
        pipeline([
          {
            ...newStep("http", []),
            id: "get",
            url: `${base}/x`,
            extract: [{ name: "newId", from: "json", path: "id" }],
            assertions: [{ target: "json", path: "echo", op: "equals", value: "GET" }],
          } as Step,
          { ...newStep("assert", []), id: "chk", assertions: [{ target: "var", path: "newId", op: "equals", value: "9" }] },
        ]),
        { http: httpExecutor, assert: async () => ({}) },
      ).result;
      expect(good.status).toBe("passed");
      const bad = await run(pipeline([{ ...newStep("http", []), id: "get", url: `${base}/missing` } as Step]), { http: httpExecutor }).result;
      expect(bad.steps[0]!.error).toBe("Expected status 2xx, got 404.");
      const wanted404 = await run(pipeline([{ ...newStep("http", []), id: "get", url: `${base}/missing`, expectStatus: "404" } as Step]), { http: httpExecutor }).result;
      expect(wanted404.status).toBe("passed");
      const down = await run(pipeline([{ ...newStep("http", []), id: "get", url: "http://127.0.0.1:1/" } as Step]), { http: httpExecutor }).result;
      expect(down.steps[0]!.error).toMatch(/Request failed/);
    } finally {
      server.close();
    }
  });

  it("container: exposes endpoints and removes the container at the end", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const callTool = async (command: string, input: Record<string, unknown>) => {
      calls.push([command, input]);
      return command === "docker.runTestContainer"
        ? { ok: true, containerId: "abcdef1234567890", name: "web1", endpoints: { "80/tcp": "127.0.0.1:49153", "443/tcp": "127.0.0.1:49154" } }
        : { ok: true };
    };
    let seen: Record<string, string> = {};
    const p = pipeline([
      { ...newStep("container", []), id: "web", connectionId: "c1", image: "nginx", ports: ["80", "443"] } as Step,
      step({ id: "use" }),
    ]);
    const r = await run(p, {
      container: containerExecutor(callTool),
      wait: async ({ vars }) => ((seen = { ...vars }), {}),
    }).result;
    expect(r.status).toBe("passed");
    expect(seen["steps.web.endpoint"]).toBe("127.0.0.1:49153");
    expect(seen["steps.web.port.443"]).toBe("49154");
    expect(seen["steps.web.host"]).toBe("127.0.0.1");
    expect(calls.map((c) => c[0])).toEqual(["docker.runTestContainer", "docker.removeContainer"]);
    expect(calls[1]![1]).toEqual({ connectionId: "c1", containerId: "abcdef1234567890" });
    expect(r.steps.at(-1)!.stepId).toBe("_cleanup");
  });

  it("container: surfaces the Docker plugin's error and keeps nothing to clean", async () => {
    const r = await run(pipeline([{ ...newStep("container", []), id: "web", connectionId: "c1", image: "nope" } as Step]), {
      container: containerExecutor(async () => ({ ok: false, error: "pull access denied" })),
    }).result;
    expect(r.steps[0]!.error).toBe("pull access denied");
    expect(r.steps.some((s) => s.stepId === "_cleanup")).toBe(false);
  });

  it("tool: sends parsed input and fails on { ok: false }", async () => {
    let sent: unknown;
    const ok = await run(pipeline([{ ...newStep("tool", []), id: "t", command: "x.y", input: '{"a":"{{v}}"}' } as Step]), { tool: toolExecutor(async (_c, i) => ((sent = i), { ok: true, text: "done" })) }, { vars: { v: "1" } }).result;
    expect(sent).toEqual({ a: "1" });
    expect(ok.steps[0]!.outputs.output).toBe("done");
    const bad = await run(pipeline([{ ...newStep("tool", []), id: "t", command: "x.y" } as Step]), { tool: toolExecutor(async () => ({ ok: false, error: "denied" })) }).result;
    expect(bad.steps[0]!.error).toBe("denied");
  });
});
