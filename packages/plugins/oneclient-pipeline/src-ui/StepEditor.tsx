import { useEffect, useState, type ReactNode } from "react";
import type { Assertion, AssertOp, AssertTarget, ContainerStep, HttpStep, SetStep, ShellStep, Step, ToolStep, WaitStep } from "../src/model.js";
import { dockerConnections, type Tool, tools as loadTools } from "./api.js";
import { formatExtract, formatKv, parseExtract, parseKv } from "./lines.js";

const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <label className="field">
    <span className="lbl">
      {label} {hint && <span className="dim">{hint}</span>}
    </span>
    {children}
  </label>
);

/** A text area that edits freely and hands the parsed value over when you leave it (so half-typed lines survive). */
function Lines({ value, onCommit, rows = 3, placeholder }: { value: string; onCommit: (text: string) => void; rows?: number; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <textarea rows={rows} value={text} placeholder={placeholder} spellCheck={false} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onCommit(text)} />;
}

const TARGETS: Array<[AssertTarget, string]> = [
  ["status", "HTTP status"],
  ["json", "JSON value"],
  ["body", "Body"],
  ["header", "Header"],
  ["duration", "Duration (ms)"],
  ["exitCode", "Exit code"],
  ["output", "Output text"],
  ["var", "Variable"],
];
const OPS: Array<[AssertOp, string]> = [
  ["equals", "equals"],
  ["notEquals", "does not equal"],
  ["contains", "contains"],
  ["notContains", "does not contain"],
  ["matches", "matches regex"],
  ["gt", "greater than"],
  ["lt", "less than"],
  ["exists", "exists"],
  ["notExists", "is missing"],
];
const NEEDS_PATH: AssertTarget[] = ["json", "header", "var"];

function Assertions({ list, onChange, targets }: { list: Assertion[]; onChange: (a: Assertion[]) => void; targets: AssertTarget[] }) {
  const set = (i: number, patch: Partial<Assertion>) => onChange(list.map((a, k) => (k === i ? { ...a, ...patch } : a)));
  return (
    <div className="asserts-edit">
      {list.map((a, i) => (
        <div className="row" key={i}>
          <select value={a.target} onChange={(e) => set(i, { target: e.target.value as AssertTarget })}>
            {TARGETS.filter(([t]) => targets.includes(t) || t === a.target).map(([t, l]) => (
              <option key={t} value={t}>
                {l}
              </option>
            ))}
          </select>
          {NEEDS_PATH.includes(a.target) && <input placeholder={a.target === "json" ? "data.items[0].id" : a.target === "header" ? "content-type" : "name"} value={a.path ?? ""} onChange={(e) => set(i, { path: e.target.value })} spellCheck={false} />}
          <select value={a.op} onChange={(e) => set(i, { op: e.target.value as AssertOp })}>
            {OPS.map(([o, l]) => (
              <option key={o} value={o}>
                {l}
              </option>
            ))}
          </select>
          {a.op !== "exists" && a.op !== "notExists" && <input placeholder="value" value={a.value ?? ""} onChange={(e) => set(i, { value: e.target.value })} spellCheck={false} />}
          <button className="btn" onClick={() => onChange(list.filter((_, k) => k !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn" onClick={() => onChange([...list, { target: targets[0] ?? "status", op: "equals", value: "" }])}>
        ＋ Add check
      </button>
    </div>
  );
}

const TARGETS_BY_KIND: Record<Step["kind"], AssertTarget[]> = {
  http: ["status", "json", "body", "header", "duration", "var"],
  shell: ["exitCode", "output", "var"],
  tool: ["output", "json", "var"],
  container: ["var"],
  wait: ["var"],
  set: ["var"],
  assert: ["var", "status", "json", "body", "output", "exitCode", "duration", "header"],
};

export function StepEditor({ step, onChange, onDuplicate }: { step: Step; onChange: (s: Step) => void; onDuplicate: () => void }) {
  const patch = (p: Partial<Step>) => onChange({ ...step, ...p } as Step);
  return (
    <div className="editor">
      <div className="row">
        <Field label="Name">
          <input value={step.name} onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        <Field label="Id" hint={`→ {{steps.${step.id}.…}}`}>
          <input value={step.id} onChange={(e) => patch({ id: e.target.value.replace(/[^A-Za-z0-9_-]/g, "") })} spellCheck={false} />
        </Field>
      </div>

      {step.kind === "shell" && <Shell step={step} onChange={onChange} />}
      {step.kind === "container" && <Container step={step} onChange={onChange} />}
      {step.kind === "http" && <Http step={step} onChange={onChange} />}
      {step.kind === "tool" && <Tool step={step} onChange={onChange} />}
      {step.kind === "wait" && (
        <Field label="Seconds">
          <input type="number" min={0} value={(step as WaitStep).seconds} onChange={(e) => onChange({ ...(step as WaitStep), seconds: Number(e.target.value) })} />
        </Field>
      )}
      {step.kind === "set" && (
        <Field label="Variables" hint="NAME=value per line">
          <Lines rows={4} value={formatKv((step as SetStep).values)} onCommit={(t) => onChange({ ...(step as SetStep), values: parseKv(t) })} />
        </Field>
      )}

      {step.kind !== "wait" && step.kind !== "set" && (
        <Field label={step.kind === "assert" ? "Checks" : "Then check"}>
          <Assertions list={step.assertions ?? []} targets={TARGETS_BY_KIND[step.kind]} onChange={(assertions) => patch({ assertions })} />
        </Field>
      )}

      <details className="opts">
        <summary>Options</summary>
        <div className="row">
          <Field label="Run when">
            <select value={step.when ?? "success"} onChange={(e) => patch({ when: e.target.value as NonNullable<Step["when"]> })}>
              <option value="success">everything before passed</option>
              <option value="always">always (teardown)</option>
              <option value="failure">something failed</option>
            </select>
          </Field>
          <Field label="Retries">
            <input type="number" min={0} value={step.retries ?? 0} onChange={(e) => patch({ retries: Number(e.target.value) })} />
          </Field>
          <Field label="Retry delay (s)">
            <input type="number" min={0} value={step.retryDelaySeconds ?? 2} onChange={(e) => patch({ retryDelaySeconds: Number(e.target.value) })} />
          </Field>
          <Field label="Timeout (s)" hint="0 = none">
            <input type="number" min={0} value={step.timeoutSeconds ?? 0} onChange={(e) => patch({ timeoutSeconds: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={!!step.continueOnError} onChange={(e) => patch({ continueOnError: e.target.checked })} /> Continue even if this step fails
          </label>
          <label className="check">
            <input type="checkbox" checked={step.enabled === false} onChange={(e) => patch({ enabled: e.target.checked ? false : true })} /> Disabled
          </label>
          <span className="grow" />
          <button className="btn" onClick={onDuplicate}>
            Duplicate step
          </button>
        </div>
      </details>
    </div>
  );
}

function Shell({ step, onChange }: { step: ShellStep; onChange: (s: Step) => void }) {
  return (
    <>
      <div className="row">
        <Field label="Shell">
          <select value={step.shell ?? "auto"} onChange={(e) => onChange({ ...step, shell: e.target.value as NonNullable<ShellStep["shell"]> })}>
            <option value="auto">Auto (PowerShell on Windows, bash elsewhere)</option>
            <option value="powershell">Windows PowerShell</option>
            <option value="pwsh">PowerShell 7 (pwsh)</option>
            <option value="bash">bash</option>
            <option value="sh">sh</option>
            <option value="cmd">cmd</option>
          </select>
        </Field>
        <Field label="Working folder" hint="optional">
          <input value={step.cwd ?? ""} onChange={(e) => onChange({ ...step, cwd: e.target.value })} spellCheck={false} />
        </Field>
      </div>
      <Field label="Script" hint="a non-zero exit fails the step · print ::set name=value to create a variable">
        <textarea className="code" rows={9} value={step.script} onChange={(e) => onChange({ ...step, script: e.target.value })} spellCheck={false} />
      </Field>
      <Field label="Environment" hint="NAME=value per line">
        <Lines value={formatKv(step.env)} onCommit={(t) => onChange({ ...step, env: parseKv(t) })} />
      </Field>
    </>
  );
}

function Container({ step, onChange }: { step: ContainerStep; onChange: (s: Step) => void }) {
  const [docker, setDocker] = useState<Array<{ id: string; name: string }> | null>(null);
  useEffect(() => {
    dockerConnections().then(setDocker).catch(() => setDocker([]));
  }, []);
  const wait = step.wait ?? { kind: "port" as const };
  return (
    <>
      <div className="row">
        <Field label="Action">
          <select value={step.action} onChange={(e) => onChange({ ...step, action: e.target.value as ContainerStep["action"] })}>
            <option value="run">Start a test container</option>
            <option value="remove">Remove a container</option>
            <option value="cleanup">Remove all test containers</option>
          </select>
        </Field>
        <Field label="Docker connection">
          <select value={step.connectionId} onChange={(e) => onChange({ ...step, connectionId: e.target.value })}>
            <option value="">{docker === null ? "Loading…" : docker.length ? "Choose…" : "No Docker connection — add one in the Docker plugin"}</option>
            {(docker ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {step.action === "run" && (
        <>
          <div className="row">
            <Field label="Image">
              <input value={step.image ?? ""} placeholder="postgres:16" onChange={(e) => onChange({ ...step, image: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="Container name" hint="optional">
              <input value={step.containerName ?? ""} onChange={(e) => onChange({ ...step, containerName: e.target.value })} spellCheck={false} />
            </Field>
          </div>
          <Field label="Ports" hint="comma separated · 5432 = random host port · 9090:8080 = fixed">
            <Lines rows={1} value={(step.ports ?? []).join(", ")} onCommit={(t) => onChange({ ...step, ports: t.split(/[\s,]+/).filter(Boolean) })} />
          </Field>
          <Field label="Environment" hint="KEY=VALUE per line">
            <Lines value={step.env ?? ""} onCommit={(t) => onChange({ ...step, env: t })} placeholder="POSTGRES_PASSWORD={{dbPassword}}" />
          </Field>
          <Field label="Command" hint="optional">
            <input value={step.cmd ?? ""} onChange={(e) => onChange({ ...step, cmd: e.target.value })} spellCheck={false} />
          </Field>
          <div className="row">
            <Field label="Wait until ready">
              <select value={wait.kind} onChange={(e) => onChange({ ...step, wait: { ...wait, kind: e.target.value as typeof wait.kind } })}>
                <option value="none">Don't wait</option>
                <option value="port">A port accepts connections</option>
                <option value="log">A log line appears</option>
                <option value="healthy">Health check passes</option>
              </select>
            </Field>
            {wait.kind === "log" && (
              <Field label="Log text">
                <input value={wait.message ?? ""} onChange={(e) => onChange({ ...step, wait: { ...wait, message: e.target.value } })} spellCheck={false} />
              </Field>
            )}
            <Field label="Timeout (s)">
              <input type="number" min={1} value={step.waitTimeoutSeconds ?? 60} onChange={(e) => onChange({ ...step, waitTimeoutSeconds: Number(e.target.value) })} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={!!step.keep} onChange={(e) => onChange({ ...step, keep: e.target.checked })} /> Leave it running after the pipeline (otherwise it is removed at the end)
          </label>
          <p className="hint">
            Later steps can use <code>{`{{steps.${step.id}.endpoint}}`}</code> (host:port), <code>{`{{steps.${step.id}.port.5432}}`}</code>, <code>{`{{steps.${step.id}.host}}`}</code> and <code>{`{{steps.${step.id}.name}}`}</code>.
          </p>
        </>
      )}
      {step.action === "remove" && (
        <Field label="Container" hint="name or id">
          <input value={step.target ?? ""} placeholder={"{{steps.db.name}}"} onChange={(e) => onChange({ ...step, target: e.target.value })} spellCheck={false} />
        </Field>
      )}
    </>
  );
}

function Http({ step, onChange }: { step: HttpStep; onChange: (s: Step) => void }) {
  return (
    <>
      <div className="row">
        <Field label="Method">
          <select value={step.method} onChange={(e) => onChange({ ...step, method: e.target.value })}>
            {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="URL">
          <input value={step.url} placeholder={"http://{{steps.web.endpoint}}/health"} onChange={(e) => onChange({ ...step, url: e.target.value })} spellCheck={false} />
        </Field>
        <Field label="Expected status" hint="2xx · 200,404 · any">
          <input value={step.expectStatus ?? "2xx"} onChange={(e) => onChange({ ...step, expectStatus: e.target.value })} spellCheck={false} />
        </Field>
      </div>
      <Field label="Headers" hint="Name: value per line">
        <Lines value={formatKv(step.headers, ": ")} onCommit={(t) => onChange({ ...step, headers: parseKv(t, ":") })} placeholder="Authorization: Bearer {{token}}" />
      </Field>
      {step.method !== "GET" && step.method !== "HEAD" && (
        <Field label="Body">
          <textarea className="code" rows={5} value={step.body ?? ""} onChange={(e) => onChange({ ...step, body: e.target.value })} spellCheck={false} />
        </Field>
      )}
      <Field label="Keep from the response" hint="name = json:path · header:Name · status · body">
        <Lines value={formatExtract(step.extract)} onCommit={(t) => onChange({ ...step, extract: parseExtract(t) })} placeholder="orderId = json:data.id" />
      </Field>
    </>
  );
}

function Tool({ step, onChange }: { step: ToolStep; onChange: (s: Step) => void }) {
  const [list, setList] = useState<Tool[] | null>(null);
  useEffect(() => {
    loadTools().then(setList).catch(() => setList([]));
  }, []);
  const tool = list?.find((t) => t.command === step.command);
  return (
    <>
      <Field label="Command" hint="offered by another plugin as a tool">
        <select value={step.command} onChange={(e) => onChange({ ...step, command: e.target.value })}>
          <option value="">{list === null ? "Loading…" : "Choose…"}</option>
          {(list ?? []).map((t) => (
            <option key={t.command} value={t.command}>
              {t.name} ({t.pluginId})
            </option>
          ))}
        </select>
      </Field>
      {tool && (
        <p className="hint">
          {tool.description}
          {tool.inputSchema?.properties && (
            <>
              {" "}
              Inputs: <code>{Object.keys(tool.inputSchema.properties).join(", ")}</code>
            </>
          )}
        </p>
      )}
      <Field label="Input" hint="JSON object — may use {{variables}}">
        <textarea className="code" rows={6} value={step.input ?? "{}"} onChange={(e) => onChange({ ...step, input: e.target.value })} spellCheck={false} />
      </Field>
    </>
  );
}
