import type { Pipeline, RunEvent, RunResult } from "../src/model.js";

export type { Pipeline, RunResult, RunEvent };
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

const params = new URLSearchParams(location.search);
export const connectionId = params.get("connectionId") ?? "";
export const pipelineId = params.get("id") ?? "";

export async function call<T>(method: string, p: Record<string, unknown> = {}): Promise<T> {
  const r = (await window.oneclientView.invokeCommand("pipeline.api", [{ connectionId, method, params: p }])) as Reply<T>;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export interface Loaded {
  pipeline: Pipeline;
  runs: RunResult[];
  active: Array<{ runId: string; pipelineId: string }>;
}
export interface SaveResult {
  pipeline: Pipeline;
  problems: string[];
}
export interface Tool {
  name: string;
  description: string;
  command: string;
  pluginId: string;
  inputSchema: { properties?: Record<string, { description?: string }> } | null;
}

export const load = () => call<Loaded>("get", { id: pipelineId });
export const save = (pipeline: Pipeline) => call<SaveResult>("save", { pipeline });
export const start = () => call<{ runId: string }>("run", { id: pipelineId });
export const cancel = (runId: string) => call<object>("cancel", { runId });
export const dockerConnections = () => call<Array<{ id: string; name: string }>>("dockerConnections");
export const tools = () => call<Tool[]>("tools");

/** Run events pushed by the backend while this view is open. */
export function onRunEvent(listener: (event: RunEvent) => void): () => void {
  const off = window.oneclientView.onMessage((m) => {
    const msg = m as { type?: string; event?: RunEvent };
    if (msg.type === "run" && msg.event) listener(msg.event);
  });
  window.oneclientView.postMessage({ type: "subscribe" });
  return off;
}
