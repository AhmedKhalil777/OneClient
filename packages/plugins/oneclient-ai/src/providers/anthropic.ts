import Anthropic from "@anthropic-ai/sdk";
import type { ChatProvider, Msg, StopReason, TurnRequest } from "../types.js";

/** Models that take adaptive thinking (Claude 4.6 and later). Older ones would reject the parameter. */
const ADAPTIVE = /claude-(fable|mythos|opus|sonnet|haiku)-5|claude-opus-4-[678]|claude-sonnet-4-6/;

/** Claude, through the official SDK. Thinking blocks are kept in `raw` and replayed unchanged, as the API requires. */
export function createAnthropicProvider(apiKey: string | undefined, baseUrl: string | undefined): ChatProvider {
  // No key given: the SDK resolves ANTHROPIC_API_KEY or an `ant auth login` profile by itself.
  const client = new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseURL: baseUrl } : {}) });

  return {
    async listModels(signal) {
      const ids: string[] = [];
      for await (const m of client.models.list({ limit: 100 }, signal ? { signal } : undefined)) ids.push(m.id);
      return ids;
    },

    async turn(req, h) {
      const adaptive = ADAPTIVE.test(req.model);
      const stream = client.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          messages: toAnthropic(req.messages),
          ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Tool.InputSchema })) } : {}),
          ...(adaptive ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
          ...(adaptive && req.effort ? { output_config: { effort: req.effort as "low" | "medium" | "high" } } : {}),
        },
        { signal: req.signal },
      );
      stream.on("text", (d) => h.onText(d));
      stream.on("thinking", (d) => h.onThinking(d));
      const message = await stream.finalMessage();

      let text = "";
      const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
      for (const block of message.content) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use") calls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      }
      const stop: StopReason =
        message.stop_reason === "tool_use" ? "tool_use" : message.stop_reason === "max_tokens" ? "max_tokens" : message.stop_reason === "refusal" ? "refusal" : message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence" ? "end" : "other";
      return {
        text,
        calls,
        raw: message.content,
        stop,
        usage: {
          input: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
          output: message.usage.output_tokens,
          cached: message.usage.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}

type Param = Anthropic.MessageParam;

/** Neutral messages → Claude's. Tool results go in one user message per assistant turn (all of them together). */
export function toAnthropic(messages: readonly Msg[]): Param[] {
  const out: Param[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      const blocks = Array.isArray(m.raw) ? (m.raw as Anthropic.ContentBlockParam[]) : [...(m.text ? [{ type: "text" as const, text: m.text }] : []), ...m.calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input }))];
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "(no reply)" }] });
    } else {
      out.push({
        role: "user",
        content: m.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
      });
    }
  }
  return out;
}

export type { TurnRequest };
