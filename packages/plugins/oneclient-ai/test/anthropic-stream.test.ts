import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../src/providers/anthropic.js";

/** A fake Messages API: records the request and streams a scripted reply in Anthropic's SSE format. */
let server: Server;
let base = "";
const bodies: Array<Record<string, unknown>> = [];

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => resolve(s));
  });

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url?.startsWith("/v1/models")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: [{ id: "claude-x", type: "model", display_name: "X", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "claude-x", last_id: "claude-x" }));
    }
    bodies.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
    res.setHeader("content-type", "text/event-stream");
    res.write(sse("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 5 } } }));
    res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }));
    res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me see" } }));
    res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }));
    res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
    res.write(sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
    res.write(sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading " } }));
    res.write(sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "now." } }));
    res.write(sse("content_block_stop", { type: "content_block_stop", index: 1 }));
    res.write(sse("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu1", name: "read_file", input: {} } }));
    res.write(sse("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } }));
    res.write(sse("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } }));
    res.write(sse("content_block_stop", { type: "content_block_stop", index: 2 }));
    res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } }));
    res.write(sse("message_stop", { type: "message_stop" }));
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("anthropic provider", () => {
  it("lists models", async () => {
    expect(await createAnthropicProvider("k", base).listModels()).toEqual(["claude-x"]);
  });

  it("streams text and thinking, builds tool calls, keeps the raw blocks, and sends adaptive thinking", async () => {
    const text: string[] = [];
    const think: string[] = [];
    const r = await createAnthropicProvider("k", base).turn(
      { model: "claude-opus-5-5", system: "sys", messages: [{ role: "user", text: "read a.ts" }], tools: [{ name: "read_file", description: "d", schema: { type: "object", properties: {} } }], maxTokens: 1000, effort: "low", signal: new AbortController().signal },
      { onText: (d) => text.push(d), onThinking: (d) => think.push(d) },
    );
    expect(text.join("")).toBe("Reading now.");
    expect(think.join("")).toBe("let me see");
    expect(r.stop).toBe("tool_use");
    expect(r.calls).toEqual([{ id: "tu1", name: "read_file", input: { path: "a.ts" } }]);
    expect(r.usage).toEqual({ input: 15, output: 7, cached: 5 });
    expect((r.raw as Array<{ type: string }>).map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(bodies[0]).toMatchObject({ model: "claude-opus-5-5", system: "sys", thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "low" } });
  });

  it("leaves thinking off for models that do not support adaptive thinking", async () => {
    await createAnthropicProvider("k", base).turn(
      { model: "claude-haiku-4-5", system: "", messages: [{ role: "user", text: "hi" }], tools: [], maxTokens: 100, signal: new AbortController().signal },
      { onText: () => undefined, onThinking: () => undefined },
    );
    expect(bodies[1]).not.toHaveProperty("thinking");
  });
});
