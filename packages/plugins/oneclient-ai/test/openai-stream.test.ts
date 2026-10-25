import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenAiProvider } from "../src/providers/openai.js";

/** A fake OpenAI-compatible server: records the request body and streams a scripted reply as SSE. */
let server: Server;
let base = "";
const bodies: Array<Record<string, unknown>> = [];
let script: unknown[][] = [];

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => resolve(s));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ object: "list", data: [{ id: "b-model", object: "model" }, { id: "a-model", object: "model" }] }));
    }
    bodies.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
    res.setHeader("content-type", "text/event-stream");
    for (const chunk of script.shift() ?? []) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());

const provider = () => createOpenAiProvider({ apiKey: "k", baseUrl: base, completionTokens: false });
const req = { model: "m", system: "sys", messages: [{ role: "user" as const, text: "hi" }], tools: [], maxTokens: 50, signal: new AbortController().signal };
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

describe("openai-compatible provider", () => {
  it("lists models sorted", async () => {
    expect(await provider().listModels()).toEqual(["a-model", "b-model"]);
  });

  it("streams text and reasoning, and reports usage", async () => {
    script = [[delta({ reasoning_content: "hmm " }), delta({ content: "Hel" }), delta({ content: "lo" }, "stop"), { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } }]];
    const text: string[] = [];
    const think: string[] = [];
    const r = await provider().turn(req, { onText: (d) => text.push(d), onThinking: (d) => think.push(d) });
    expect(text.join("")).toBe("Hello");
    expect(think.join("")).toBe("hmm ");
    expect(r).toMatchObject({ text: "Hello", stop: "end", usage: { input: 12, output: 3, cached: 4 }, raw: { reasoning_content: "hmm " } });
    expect(bodies.at(-1)).toMatchObject({ model: "m", stream: true, max_tokens: 50 });
  });

  it("assembles tool calls that arrive in pieces", async () => {
    script = [[delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }, "tool_calls")]];
    const r = await provider().turn({ ...req, tools: [{ name: "read_file", description: "d", schema: { type: "object" } }] }, { onText: () => undefined, onThinking: () => undefined });
    expect(r.stop).toBe("tool_use");
    expect(r.calls).toEqual([{ id: "call_1", name: "read_file", input: { path: "a.ts" } }]);
    expect((bodies.at(-1)?.tools as unknown[]).length).toBe(1);
  });

  it("maps length to max_tokens and survives malformed tool arguments", async () => {
    script = [[delta({ content: "cut" }, "length")], [delta({ tool_calls: [{ index: 0, id: "x", function: { name: "t", arguments: "{oops" } }] }, "tool_calls")]];
    const h = { onText: () => undefined, onThinking: () => undefined };
    expect((await provider().turn(req, h)).stop).toBe("max_tokens");
    expect((await provider().turn(req, h)).calls[0]?.input).toEqual({});
  });
});
