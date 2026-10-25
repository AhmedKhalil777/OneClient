import OpenAI from "openai";
import type { ChatProvider, Msg, StopReason, ToolCall } from "../types.js";

export interface OpenAiOptions {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  /** OpenAI's own newer models want `max_completion_tokens`. */
  completionTokens: boolean;
}

/**
 * Any server that speaks OpenAI's chat-completions protocol: OpenAI, Gemini, DeepSeek, Kimi, GLM, Grok, Mistral,
 * Qwen, OpenRouter, Ollama, LM Studio, vLLM… Reasoning models' `reasoning_content` is shown as thinking and sent
 * back with the turn, which DeepSeek and Kimi need to continue a tool conversation.
 */
export function createOpenAiProvider(opts: OpenAiOptions): ChatProvider {
  const client = new OpenAI({
    // Local servers ignore the key, but the SDK insists on one.
    apiKey: opts.apiKey || "not-needed",
    ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
  });

  return {
    async listModels(signal) {
      const ids: string[] = [];
      for await (const m of client.models.list(signal ? { signal } : undefined)) ids.push(m.id);
      return ids.sort();
    },

    async turn(req, h) {
      const stream = await client.chat.completions.create(
        {
          model: req.model,
          stream: true,
          stream_options: { include_usage: true },
          messages: toOpenAi(req.system, req.messages),
          ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}),
          ...(opts.completionTokens ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
        },
        { signal: req.signal },
      );

      let text = "";
      let reasoning = "";
      let finish: string | null = null;
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let usage = { input: 0, output: 0, cached: 0 };

      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = {
            input: chunk.usage.prompt_tokens ?? 0,
            output: chunk.usage.completion_tokens ?? 0,
            cached: (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens ?? 0,
          };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta as { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
        const think = delta.reasoning_content ?? delta.reasoning;
        if (think) {
          reasoning += think;
          h.onThinking(think);
        }
        if (delta.content) {
          text += delta.content;
          h.onText(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }

      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, c]) => ({ id: c.id || `call_${i}_${Date.now()}`, name: c.name, input: parseArgs(c.args) }));
      const stop: StopReason = toolCalls.length ? "tool_use" : finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : finish === "stop" || finish === null ? "end" : "other";
      return { text, calls: toolCalls, ...(reasoning ? { raw: { reasoning_content: reasoning } } : {}), usage, stop };
    },
  };
}

/** Tool arguments arrive as a JSON string; a model that streams bad JSON gets an empty input (the tool then reports what was missing). */
function parseArgs(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type Param = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toOpenAi(system: string, messages: readonly Msg[]): Param[] {
  const out: Param[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      const reasoning = (m.raw as { reasoning_content?: string } | undefined)?.reasoning_content;
      out.push({
        role: "assistant",
        content: m.text || null,
        ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      } as Param);
    } else {
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  }
  return out;
}
