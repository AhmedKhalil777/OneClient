import type { PluginToolset } from "./plugin-tools.js";
import { TOOLS, type ToolHost, runTool } from "./tools.js";
import type { ChatProvider, Conversation, StopReason, ToolCall, Usage } from "./types.js";

/** What the chat view is told while a turn runs. */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "assistant_done" }
  | { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; id: string; content: string; isError: boolean }
  | { type: "usage"; usage: Usage };

export interface AgentOptions {
  provider: ChatProvider;
  model: string;
  system: string;
  effort?: string | undefined;
  maxTokens: number;
  workspaceTools: boolean;
  /** Tools of other plugins (SQL, …), when the connection allows them. */
  plugins?: PluginToolset | undefined;
  host: ToolHost;
  signal: AbortSignal;
  emit(event: AgentEvent): void;
  /** Called after every completed step so a closed tab or a crash loses nothing. */
  persist(): void;
}

const MAX_STEPS = 30;

export const STOP_NOTES: Partial<Record<StopReason, string>> = {
  max_tokens: "The reply was cut off because it hit the output limit. Say “continue” to go on.",
  refusal: "The model declined to answer this request.",
};

/**
 * Runs the conversation forward from its last user message: model turn → tool calls → results → model turn …
 * until the model answers without calling tools. History is append-only (thinking blocks must stay as they were).
 */
export async function runAgent(conv: Conversation, o: AgentOptions): Promise<StopReason> {
  const tools = [...(o.workspaceTools ? TOOLS : []), ...(o.plugins?.defs ?? [])];
  const builtin = new Set(TOOLS.map((t) => t.name));
  for (let step = 0; step < MAX_STEPS; step++) {
    const result = await o.provider.turn(
      { model: o.model, system: o.system, messages: conv.messages, tools, maxTokens: o.maxTokens, effort: o.effort, signal: o.signal },
      { onText: (delta) => o.emit({ type: "text", delta }), onThinking: (delta) => o.emit({ type: "thinking", delta }) },
    );
    conv.usage.input += result.usage.input;
    conv.usage.output += result.usage.output;
    conv.usage.cached = (conv.usage.cached ?? 0) + (result.usage.cached ?? 0);
    conv.messages.push({ role: "assistant", text: result.text, calls: result.calls, ...(result.raw !== undefined ? { raw: result.raw } : {}), model: o.model });
    o.emit({ type: "assistant_done" });
    o.emit({ type: "usage", usage: conv.usage });
    o.persist();

    if (result.stop !== "tool_use" || !result.calls.length) return result.stop;

    const results = [];
    for (const call of result.calls) {
      if (o.signal.aborted) {
        results.push({ id: call.id, name: call.name, content: "Stopped by the user before this ran.", isError: true });
        continue;
      }
      o.emit({ type: "tool_start", id: call.id, name: call.name, input: call.input });
      const r = (!builtin.has(call.name) && (await o.plugins?.call(call as ToolCall, o.host.approve))) || (await runTool(call as ToolCall, o.host));
      o.emit({ type: "tool_end", id: call.id, content: r.content.length > 6000 ? `${r.content.slice(0, 6000)}\n…` : r.content, isError: r.isError ?? false });
      results.push(r);
    }
    conv.messages.push({ role: "tool", results });
    o.persist();
    if (o.signal.aborted) return "other";
  }
  return "other";
}
