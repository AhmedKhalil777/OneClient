import { randomUUID } from "node:crypto";
import type { PluginContext } from "@oneclient/plugin-api";
import { type RunEvent, runPipeline } from "./engine.js";
import { assertExecutor, containerExecutor, httpExecutor, setExecutor, shellExecutor, toolExecutor, waitExecutor } from "./executors.js";
import { examplePipeline } from "./example.js";
import { normalizePipeline, type Pipeline, type RunResult, validatePipeline } from "./model.js";
import { storeFor } from "./store.js";

type Listener = (event: RunEvent) => void;

const secretKey = (connectionId: string, pipelineId: string, name: string) => `pipeline:${connectionId}:${pipelineId}:${name}`;

/** Pipelines and runs for every pipeline workspace connection. */
export class PipelineService {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly active = new Map<string, { connectionId: string; pipelineId: string; abort: AbortController }>();
  /** Output → Pipelines → Runs: every run, step and failure, with the step's log as expandable detail. */
  private readonly out;

  constructor(private readonly context: PluginContext) {
    this.out = context.createOutputChannel("Runs");
  }

  // ------------------------------------------------------------ live events

  subscribe(connectionId: string, listener: Listener): void {
    let set = this.listeners.get(connectionId);
    if (!set) this.listeners.set(connectionId, (set = new Set()));
    set.add(listener);
  }

  private emit(connectionId: string, event: RunEvent): void {
    for (const l of [...(this.listeners.get(connectionId) ?? [])]) {
      try {
        l(event);
      } catch {
        // The view instance behind this listener is gone.
        this.listeners.get(connectionId)?.delete(l);
      }
    }
  }

  // ------------------------------------------------------------ pipelines

  list(connectionId: string) {
    const { pipelines, runs } = storeFor(connectionId).get();
    return pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? "",
      steps: p.steps.length,
      lastRun: runs[p.id]?.[0] ? { status: runs[p.id]![0]!.status, startedAt: runs[p.id]![0]!.startedAt, durationMs: runs[p.id]![0]!.durationMs } : null,
      running: [...this.active.values()].some((a) => a.connectionId === connectionId && a.pipelineId === p.id),
    }));
  }

  get(connectionId: string, id: string): Pipeline {
    const p = storeFor(connectionId).get().pipelines.find((x) => x.id === id);
    if (!p) throw new Error("That pipeline no longer exists.");
    // Secret values never go back to the editor.
    return { ...p, variables: p.variables.map((v) => (v.secret ? { ...v, value: "" } : v)) };
  }

  async create(connectionId: string, name: string, example = false): Promise<Pipeline> {
    const base = example ? examplePipeline((await this.dockerConnections())[0]?.id ?? "") : { name: name.trim() || "New pipeline", variables: [], steps: [] };
    const pipeline: Pipeline = normalizePipeline({ ...base, ...(example || !name.trim() ? {} : { name: name.trim() }), id: randomUUID(), updatedAt: Date.now() });
    storeFor(connectionId).update((d) => void d.pipelines.push(pipeline));
    return pipeline;
  }

  async save(connectionId: string, incoming: Pipeline): Promise<{ pipeline: Pipeline; problems: string[] }> {
    const store = storeFor(connectionId);
    const existing = store.get().pipelines.find((p) => p.id === incoming.id);
    if (!existing) throw new Error("That pipeline no longer exists.");
    const next = normalizePipeline({ ...incoming, updatedAt: Date.now() });
    // Secret values move to the secret store; the file keeps only the name and that one is set.
    for (const v of next.variables) {
      if (!v.secret) {
        delete v.secretSet;
        continue;
      }
      const key = secretKey(connectionId, next.id, v.name);
      if (v.value !== "") await this.context.secrets.set(key, v.value);
      v.secretSet = v.value !== "" || (await this.context.secrets.get(key)) !== undefined;
      v.value = "";
    }
    for (const old of existing.variables) {
      if (old.secret && !next.variables.some((v) => v.secret && v.name === old.name)) await this.context.secrets.delete(secretKey(connectionId, next.id, old.name));
    }
    store.update((d) => {
      d.pipelines[d.pipelines.findIndex((p) => p.id === next.id)] = next;
    });
    return { pipeline: this.get(connectionId, next.id), problems: validatePipeline(next) };
  }

  async remove(connectionId: string, id: string): Promise<void> {
    const store = storeFor(connectionId);
    const p = store.get().pipelines.find((x) => x.id === id);
    if (!p) return;
    for (const v of p.variables) if (v.secret) await this.context.secrets.delete(secretKey(connectionId, id, v.name));
    store.update((d) => {
      d.pipelines = d.pipelines.filter((x) => x.id !== id);
    });
  }

  async duplicate(connectionId: string, id: string): Promise<Pipeline> {
    const src = storeFor(connectionId).get().pipelines.find((p) => p.id === id);
    if (!src) throw new Error("That pipeline no longer exists.");
    const copy: Pipeline = { ...structuredClone(src), id: randomUUID(), name: `${src.name} copy`, updatedAt: Date.now() };
    for (const v of copy.variables) {
      if (!v.secret) continue;
      const value = await this.context.secrets.get(secretKey(connectionId, id, v.name));
      if (value !== undefined) await this.context.secrets.set(secretKey(connectionId, copy.id, v.name), value);
    }
    storeFor(connectionId).update((d) => void d.pipelines.push(copy));
    return copy;
  }

  runs(connectionId: string, id: string): RunResult[] {
    return storeFor(connectionId).get().runs[id] ?? [];
  }

  /** The user's Docker connections, for container steps. */
  async dockerConnections() {
    return (await this.context.connections.list()).filter((c) => c.typeId === "docker").map((c) => ({ id: c.id, name: c.name }));
  }

  /** Commands other plugins offer as tools (`oneclient.aiTools`), for plugin-command steps. */
  async tools() {
    const list = await this.context.contributions.get<{ name: string; description: string; command: string; inputSchema?: unknown }>("oneclient.aiTools");
    return list.map((t) => ({ name: t.name, description: t.description, command: t.command, pluginId: t.pluginId, inputSchema: t.inputSchema ?? null }));
  }

  // ------------------------------------------------------------ running

  /** Starts a run in the background and returns its id; progress arrives as events and in the Tasks panel. */
  async start(connectionId: string, pipelineId: string, overrides: Record<string, string> = {}): Promise<{ runId: string }> {
    const store = storeFor(connectionId);
    const pipeline = store.get().pipelines.find((p) => p.id === pipelineId);
    if (!pipeline) throw new Error("That pipeline no longer exists.");
    if ([...this.active.values()].some((a) => a.connectionId === connectionId && a.pipelineId === pipelineId)) throw new Error("This pipeline is already running.");
    const problems = validatePipeline(pipeline);
    if (problems.length) throw new Error(problems.join("\n"));

    const vars: Record<string, string> = {};
    const secrets: string[] = [];
    for (const v of pipeline.variables) {
      let value = v.value;
      if (v.secret) {
        value = (await this.context.secrets.get(secretKey(connectionId, pipelineId, v.name))) ?? "";
        if (value) secrets.push(value);
      }
      vars[v.name] = value;
    }
    for (const [k, v] of Object.entries(overrides)) vars[k] = v;

    const runId = randomUUID();
    const abort = new AbortController();
    this.active.set(runId, { connectionId, pipelineId, abort });

    const callTool = (command: string, input: Record<string, unknown>) => this.context.aiTools.call(command, input);
    const work = this.context.tasks.run({ title: `Pipeline: ${pipeline.name}`, cancellable: true }, async (task) => {
      task.onCancel(() => abort.abort());
      const result = await runPipeline(pipeline, {
        runId,
        vars,
        secrets,
        signal: abort.signal,
        executors: {
          shell: shellExecutor,
          http: httpExecutor,
          wait: waitExecutor,
          set: setExecutor,
          assert: assertExecutor,
          tool: toolExecutor(callTool),
          container: containerExecutor(callTool),
        },
        onEvent: (e) => {
          this.emit(connectionId, e);
          this.record(pipeline.name, e);
          if (e.type === "stepStart") {
            task.report({ detail: e.name });
            task.log(`\n▶ ${e.name}\n`);
          } else if (e.type === "stepLog") task.log(e.text);
        },
      });
      store.update((d) => {
        (d.runs[pipelineId] ??= []).unshift(result);
      });
      if (result.status === "failed") throw new Error(`${pipeline.name} failed.`);
      return result;
    });
    void work.catch((err: unknown) => this.out.error(`“${pipeline.name}” could not finish: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err.stack : undefined)).finally(() => {
      this.active.delete(runId);
      this.context.refreshExplorer(connectionId);
    });
    return { runId };
  }

  private record(name: string, e: RunEvent): void {
    if (e.type === "runStart") this.out.info(`▶ “${name}” started (${e.steps.length} steps).`);
    else if (e.type === "stepEnd") {
      const r = e.result;
      const line = `${r.name}: ${r.status}${r.attempts > 1 ? ` after ${r.attempts} attempts` : ""} (${r.durationMs} ms)`;
      if (r.status === "failed") this.out.error(`✗ ${line} — ${r.error ?? ""}`, r.log);
      else if (r.status === "ignored") this.out.warn(`! ${line} — ${r.error ?? ""} (ignored)`, r.log);
      else if (r.status !== "skipped") this.out.info(`${r.status === "passed" ? "✓" : "■"} ${line}`);
    } else if (e.type === "runEnd") {
      const level = e.result.status === "failed" ? "error" : e.result.status === "cancelled" ? "warn" : "info";
      this.out.log(level, `■ “${name}” ${e.result.status} in ${(e.result.durationMs / 1000).toFixed(1)}s.`);
    }
  }

  cancel(runId: string): void {
    this.active.get(runId)?.abort.abort();
  }

  activeRuns(connectionId: string): Array<{ runId: string; pipelineId: string }> {
    return [...this.active.entries()].filter(([, a]) => a.connectionId === connectionId).map(([runId, a]) => ({ runId, pipelineId: a.pipelineId }));
  }

  cancelAll(): void {
    for (const a of this.active.values()) a.abort.abort();
  }
}
