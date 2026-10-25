import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { newStep, STEP_TITLES, type Step, type StepKind, type StepResult, type StepStatus } from "../src/model.js";
import { cancel, load, onRunEvent, type Pipeline, type RunEvent, type RunResult, save, start } from "./api.js";
import { StepEditor } from "./StepEditor.js";

type Tab = "steps" | "variables" | "history" | "json";

/** Live state of the run being shown: one entry per step, filled in from events. */
interface LiveRun {
  runId: string;
  status: "running" | RunResult["status"];
  steps: Array<{ stepId: string; name: string; kind: string; status: StepStatus; log: string; durationMs: number; error?: string; assertions: StepResult["assertions"]; attempts: number }>;
  durationMs: number;
}

const ICON: Record<StepStatus, string> = { pending: "○", running: "◐", passed: "✓", failed: "✗", skipped: "–", ignored: "!", cancelled: "■" };

function fromResult(r: RunResult): LiveRun {
  return {
    runId: r.runId,
    status: r.status,
    durationMs: r.durationMs,
    steps: r.steps.map((s) => ({ stepId: s.stepId, name: s.name, kind: "", status: s.status, log: s.log, durationMs: s.durationMs, ...(s.error ? { error: s.error } : {}), assertions: s.assertions, attempts: s.attempts })),
  };
}

function reduce(run: LiveRun | null, e: RunEvent): LiveRun | null {
  if (e.type === "runStart") {
    return {
      runId: e.runId,
      status: "running",
      durationMs: 0,
      steps: e.steps.map((s) => ({ stepId: s.stepId, name: s.name, kind: s.kind, status: s.skipped ? "skipped" : "pending", log: "", durationMs: 0, assertions: [], attempts: 0 })),
    };
  }
  if (!run || run.runId !== e.runId) return run;
  if (e.type === "runEnd") return fromResult(e.result);
  const steps = [...run.steps];
  const cur = steps[e.index] ?? { stepId: "", name: "", kind: "", status: "pending" as StepStatus, log: "", durationMs: 0, assertions: [], attempts: 0 };
  if (e.type === "stepStart") steps[e.index] = { ...cur, stepId: e.stepId, name: e.name, status: "running", attempts: e.attempt };
  else if (e.type === "stepLog") steps[e.index] = { ...cur, log: cur.log + e.text };
  else if (e.type === "stepEnd") steps[e.index] = { ...cur, status: e.result.status, durationMs: e.result.durationMs, log: e.result.log, assertions: e.result.assertions, attempts: e.result.attempts, ...(e.result.error ? { error: e.result.error } : {}) };
  return { ...run, steps };
}

export function App() {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [history, setHistory] = useState<RunResult[]>([]);
  const [tab, setTab] = useState<Tab>("steps");
  const [selected, setSelected] = useState(0);
  const [dirty, setDirtyState] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [run, setRun] = useState<LiveRun | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const runRef = useRef<LiveRun | null>(null);
  runRef.current = run;

  const setDirty = (d: boolean) => {
    setDirtyState(d);
    window.oneclientView.setDirty(d);
  };

  useEffect(() => {
    load()
      .then((l) => {
        setPipeline(l.pipeline);
        setHistory(l.runs);
        if (l.runs[0]) setRun(fromResult(l.runs[0]));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return onRunEvent((e) => {
      setRun((r) => reduce(r, e));
      if (e.type === "runEnd") setHistory((h) => [e.result, ...h.filter((x) => x.runId !== e.result.runId)].slice(0, 20));
    });
  }, []);

  const update = useCallback((fn: (p: Pipeline) => Pipeline) => {
    setPipeline((p) => (p ? fn(p) : p));
    setDirty(true);
  }, []);

  const doSave = useCallback(async (): Promise<boolean> => {
    if (!pipeline) return false;
    try {
      const r = await save(pipeline);
      setProblems(r.problems);
      setDirty(false);
      window.oneclientView.refreshExplorer();
      setError("");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [pipeline]);

  async function doRun() {
    if (dirty && !(await doSave())) return;
    try {
      await start();
      setError("");
      setTab("steps");
      setViewing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void doSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSave]);

  const running = run?.status === "running";
  const step = pipeline?.steps[selected];
  const shownIndex = viewing ?? (running ? Math.max(0, run?.steps.findIndex((s) => s.status === "running") ?? 0) : selected);
  const shown = run?.steps[shownIndex];

  const addStep = (kind: StepKind) =>
    update((p) => {
      const s = newStep(kind, p.steps);
      setSelected(p.steps.length);
      return { ...p, steps: [...p.steps, s] };
    });

  const move = (i: number, d: -1 | 1) =>
    update((p) => {
      const j = i + d;
      if (j < 0 || j >= p.steps.length) return p;
      const steps = [...p.steps];
      [steps[i], steps[j]] = [steps[j]!, steps[i]!];
      setSelected(j);
      return { ...p, steps };
    });

  const passedCount = useMemo(() => run?.steps.filter((s) => s.status === "passed").length ?? 0, [run]);

  if (error && !pipeline) return <div className="msg error">{error}</div>;
  if (!pipeline) return <div className="msg">Loading…</div>;

  return (
    <div className="page">
      <div className="bar">
        <input className="title" value={pipeline.name} onChange={(e) => update((p) => ({ ...p, name: e.target.value }))} spellCheck={false} />
        <span className="grow" />
        {run && <span className={`pill ${run.status}`}>{running ? `running… ${passedCount}/${run.steps.length}` : `${run.status} · ${(run.durationMs / 1000).toFixed(1)}s`}</span>}
        <button className="btn" disabled={!dirty} onClick={() => void doSave()} title="Ctrl+S">
          Save{dirty ? " ●" : ""}
        </button>
        {running ? (
          <button className="btn danger" onClick={() => run && void cancel(run.runId)}>
            ■ Stop
          </button>
        ) : (
          <button className="btn primary" disabled={pipeline.steps.length === 0} onClick={() => void doRun()}>
            ▶ Run
          </button>
        )}
      </div>
      {(error || problems.length > 0) && (
        <div className="banner error">
          {error && <div>{error}</div>}
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
      <div className="tabs">
        {(["steps", "variables", "history", "json"] as Tab[]).map((t) => (
          <button key={t} className={`tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
            {t === "json" ? "JSON" : t[0]!.toUpperCase() + t.slice(1)}
            {t === "variables" && pipeline.variables.length ? ` (${pipeline.variables.length})` : ""}
          </button>
        ))}
      </div>

      {tab === "steps" && (
        <div className="split">
          <div className="steps">
            {pipeline.steps.length === 0 && <div className="hint">No steps yet. Add a script, a test container or an HTTP request below.</div>}
            {pipeline.steps.map((s, i) => {
              const live = run?.steps[i];
              const status: StepStatus = live && live.stepId === s.id ? live.status : "pending";
              return (
                <div key={s.id + i} className={`step${i === selected ? " on" : ""}${s.enabled === false ? " off" : ""}`} onClick={() => (setSelected(i), setViewing(null))}>
                  <span className={`dot ${status}`} title={status}>
                    {ICON[status]}
                  </span>
                  <span className="kind">{s.kind}</span>
                  <span className="name">{s.name}</span>
                  {s.when && s.when !== "success" && <span className="tag">{s.when}</span>}
                  <span className="acts">
                    <button title="Move up" onClick={(e) => (e.stopPropagation(), move(i, -1))}>
                      ↑
                    </button>
                    <button title="Move down" onClick={(e) => (e.stopPropagation(), move(i, 1))}>
                      ↓
                    </button>
                    <button
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        update((p) => ({ ...p, steps: p.steps.filter((_, k) => k !== i) }));
                        setSelected(Math.max(0, selected - (i <= selected ? 1 : 0)));
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              );
            })}
            <select
              className="add"
              value=""
              onChange={(e) => e.target.value && addStep(e.target.value as StepKind)}
            >
              <option value="">＋ Add step…</option>
              {(Object.keys(STEP_TITLES) as StepKind[]).map((k) => (
                <option key={k} value={k}>
                  {STEP_TITLES[k]}
                </option>
              ))}
            </select>
          </div>

          <div className="detail">
            {step ? (
              <StepEditor
                key={step.id + selected}
                step={step}
                onChange={(s: Step) => update((p) => ({ ...p, steps: p.steps.map((x, i) => (i === selected ? s : x)) }))}
                onDuplicate={() =>
                  update((p) => {
                    const copy = { ...structuredClone(step), id: newStep(step.kind, p.steps).id, name: `${step.name} copy` } as Step;
                    setSelected(selected + 1);
                    return { ...p, steps: [...p.steps.slice(0, selected + 1), copy, ...p.steps.slice(selected + 1)] };
                  })
                }
              />
            ) : (
              <div className="hint">Select a step to edit it.</div>
            )}
            <RunOutput run={run} index={shownIndex} step={shown} onPick={setViewing} />
          </div>
        </div>
      )}

      {tab === "variables" && <Variables pipeline={pipeline} update={update} />}

      {tab === "history" && (
        <div className="pad">
          {history.length === 0 && <div className="hint">No runs yet.</div>}
          {history.map((r) => (
            <div key={r.runId} className="hist" onClick={() => (setRun(fromResult(r)), setTab("steps"), setViewing(null))}>
              <span className={`pill ${r.status}`}>{r.status}</span>
              <span>{new Date(r.startedAt).toLocaleString()}</span>
              <span className="dim">{(r.durationMs / 1000).toFixed(1)}s · {r.steps.filter((s) => s.status === "passed").length}/{r.steps.length} steps passed</span>
            </div>
          ))}
        </div>
      )}

      {tab === "json" && <JsonTab pipeline={pipeline} onApply={(p) => (update(() => p), setSelected(0))} />}
    </div>
  );
}

function RunOutput({ run, index, step, onPick }: { run: LiveRun | null; index: number; step: LiveRun["steps"][number] | undefined; onPick: (i: number) => void }) {
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [step?.log]);
  if (!run) return <div className="output hint">Run the pipeline to see each step's output here.</div>;
  return (
    <div className="output">
      <div className="out-head">
        {run.steps.map((s, i) => (
          <button key={i} className={`chip ${s.status}${i === index ? " on" : ""}`} onClick={() => onPick(i)} title={s.name}>
            {ICON[s.status]} {s.name}
          </button>
        ))}
      </div>
      {step && (
        <>
          <div className="out-meta">
            <strong>{step.name}</strong> · {step.status}
            {step.attempts > 1 ? ` · ${step.attempts} attempts` : ""}
            {step.durationMs ? ` · ${(step.durationMs / 1000).toFixed(2)}s` : ""}
          </div>
          {step.assertions.length > 0 && (
            <ul className="asserts">
              {step.assertions.map((a, i) => (
                <li key={i} className={a.passed ? "ok" : "bad"}>
                  {a.passed ? "✓" : "✗"} {a.message}
                </li>
              ))}
            </ul>
          )}
          {step.error && <div className="banner error pre">{step.error}</div>}
          <pre className="log" ref={logRef}>
            {step.log || "(no output)"}
          </pre>
        </>
      )}
    </div>
  );
}

function Variables({ pipeline, update }: { pipeline: Pipeline; update: (fn: (p: Pipeline) => Pipeline) => void }) {
  const set = (i: number, patch: Partial<Pipeline["variables"][number]>) =>
    update((p) => ({ ...p, variables: p.variables.map((v, k) => (k === i ? { ...v, ...patch } : v)) }));
  return (
    <div className="pad">
      <p className="hint">
        Use a variable anywhere in a step as <code>{"{{name}}"}</code>. A step's outputs are <code>{"{{steps.<id>.<output>}}"}</code> — e.g. a test container's <code>{"{{steps.db.endpoint}}"}</code>, <code>{"{{steps.db.port.5432}}"}</code>. Built-ins: <code>{"{{$guid}}"}</code>,{" "}
        <code>{"{{$timestamp}}"}</code>, <code>{"{{$random}}"}</code>. Secrets are kept in the secret store and masked in logs.
      </p>
      {pipeline.variables.map((v, i) => (
        <div className="row" key={i}>
          <input placeholder="name" value={v.name} onChange={(e) => set(i, { name: e.target.value })} spellCheck={false} />
          <input
            placeholder={v.secret && v.secretSet ? "•••••• (stored — type to replace)" : "value"}
            type={v.secret ? "password" : "text"}
            value={v.value}
            onChange={(e) => set(i, { value: e.target.value })}
            spellCheck={false}
          />
          <label className="check">
            <input type="checkbox" checked={!!v.secret} onChange={(e) => set(i, { secret: e.target.checked })} /> secret
          </label>
          <button className="btn" onClick={() => update((p) => ({ ...p, variables: p.variables.filter((_, k) => k !== i) }))}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn" onClick={() => update((p) => ({ ...p, variables: [...p.variables, { name: "", value: "" }] }))}>
        ＋ Add variable
      </button>
    </div>
  );
}

function JsonTab({ pipeline, onApply }: { pipeline: Pipeline; onApply: (p: Pipeline) => void }) {
  const pretty = useMemo(() => JSON.stringify({ ...pipeline, variables: pipeline.variables.map((v) => (v.secret ? { ...v, value: "" } : v)) }, null, 2), [pipeline]);
  const [text, setText] = useState(pretty);
  const [err, setErr] = useState("");
  useEffect(() => setText(pretty), [pretty]);
  return (
    <div className="pad">
      <p className="hint">The whole pipeline as JSON — copy it to share a scenario, or paste one here and apply.</p>
      <textarea className="json" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      {err && <div className="banner error">{err}</div>}
      <button
        className="btn"
        onClick={() => {
          try {
            const p = JSON.parse(text) as Pipeline;
            if (!Array.isArray(p.steps)) throw new Error("Expected a pipeline with a steps array.");
            onApply({ ...p, id: pipeline.id, variables: Array.isArray(p.variables) ? p.variables : [] });
            setErr("");
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        Apply
      </button>
    </div>
  );
}
