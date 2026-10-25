import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentEvent, runAgent } from "../src/agent.js";
import { toAnthropic } from "../src/providers/anthropic.js";
import { toOpenAi } from "../src/providers/openai.js";
import { ConversationStore, transcript } from "../src/store.js";
import { type ToolHost, resolveInFolders, runTool } from "../src/tools.js";
import type { ChatProvider, Conversation, Msg, ToolCall, TurnResult } from "../src/types.js";

const tmp = () => mkdtempSync(join(tmpdir(), "oc-ai-"));
const host = (root: string, approve = true): ToolHost => ({ folders: async () => [{ name: "proj", path: root }], approve: async () => approve });
const call = (name: string, input: Record<string, unknown>, id = "t1"): ToolCall => ({ id, name, input });

describe("path safety", () => {
  const folders = [{ name: "proj", path: "/work/proj" }];
  it("accepts paths inside an open folder, by name or absolute", () => {
    expect(resolveInFolders(folders, "proj/src/a.ts").replace(/\\/g, "/")).toMatch(/work\/proj\/src\/a\.ts$/);
    expect(resolveInFolders(folders, "src/a.ts").replace(/\\/g, "/")).toMatch(/work\/proj\/src\/a\.ts$/);
  });
  it("refuses anything that escapes", () => {
    expect(() => resolveInFolders(folders, "../secret.txt")).toThrow(/outside/);
    expect(() => resolveInFolders(folders, "proj/../../etc/passwd")).toThrow(/outside/);
    expect(() => resolveInFolders([], "a")).toThrow(/No folder/);
  });
});

describe("tools", () => {
  it("lists, reads (with line numbers) and searches", async () => {
    const root = tmp();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "src", "a.ts"), "one\ntwo needle\nthree\n");
    writeFileSync(join(root, "node_modules", "x.ts"), "needle");
    const h = host(root);
    expect((await runTool(call("list_files", { path: "proj" }), h)).content).toContain("src/");
    expect((await runTool(call("read_file", { path: "src/a.ts", start_line: 2, end_line: 2 }), h)).content).toBe("2\ttwo needle\n… (1 more lines; file has 3)\n");
    const found = (await runTool(call("search_files", { pattern: "NEEDLE", glob: "*.ts" }), h)).content;
    expect(found).toContain("a.ts:2: two needle");
    expect(found).not.toContain("node_modules");
  });

  it("edits only with approval, only on a unique match, and keeps CRLF", async () => {
    const root = tmp();
    const file = join(root, "f.txt");
    writeFileSync(file, "a\r\nb\r\nb\r\n");
    expect((await runTool(call("edit_file", { path: "f.txt", old_text: "b", new_text: "c" }), host(root))).isError).toBe(true); // twice
    expect((await runTool(call("edit_file", { path: "f.txt", old_text: "a", new_text: "z" }), host(root, false))).isError).toBe(true); // declined
    expect(readFileSync(file, "utf8")).toBe("a\r\nb\r\nb\r\n");
    expect((await runTool(call("edit_file", { path: "f.txt", old_text: "a", new_text: "z" }), host(root))).isError).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("z\r\nb\r\nb\r\n");
  });

  it("writes new files (creating folders) only with approval", async () => {
    const root = tmp();
    expect((await runTool(call("write_file", { path: "d/new.txt", content: "hi" }), host(root, false))).isError).toBe(true);
    expect((await runTool(call("write_file", { path: "d/new.txt", content: "hi" }), host(root))).isError).toBeUndefined();
    expect(readFileSync(join(root, "d", "new.txt"), "utf8")).toBe("hi");
  });
});

describe("provider message conversion", () => {
  const conv: Msg[] = [
    { role: "user", text: "hi" },
    { role: "assistant", text: "looking", calls: [call("read_file", { path: "a" }, "c1"), call("list_files", {}, "c2")], raw: { reasoning_content: "think" } },
    { role: "tool", results: [{ id: "c1", name: "read_file", content: "A" }, { id: "c2", name: "list_files", content: "B", isError: true }] },
  ];
  it("openai: tool calls, one tool message per result, reasoning echoed back", () => {
    const out = toOpenAi("sys", conv) as Array<Record<string, unknown>>;
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect(out[2]!.reasoning_content).toBe("think");
    expect((out[2]!.tool_calls as Array<{ function: { arguments: string } }>)[0]!.function.arguments).toBe('{"path":"a"}');
    expect(out[3]!.tool_call_id).toBe("c1");
  });
  it("anthropic: all tool results in one user message; raw content blocks replayed unchanged", () => {
    const withRaw: Msg[] = [conv[0]!, { ...(conv[1] as Extract<Msg, { role: "assistant" }>), raw: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "tool_use", id: "c1", name: "read_file", input: {} }] }, conv[2]!];
    const out = toAnthropic(withRaw);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect((out[1]!.content as Array<{ type: string }>)[0]!.type).toBe("thinking");
    const results = out[2]!.content as Array<{ type: string; is_error?: boolean }>;
    expect(results).toHaveLength(2);
    expect(results[1]!.is_error).toBe(true);
  });
});

describe("conversation store", () => {
  it("saves, lists newest first, renames, deletes, and rejects bad ids", () => {
    const store = new ConversationStore(tmp());
    const a = store.open("conn1", "a");
    a.messages.push({ role: "user", text: "first" });
    store.save("conn1", a);
    const b = store.open("conn1", "b");
    b.messages.push({ role: "user", text: "second" });
    store.save("conn1", b);
    expect(store.list("conn1").map((c) => c.id)).toEqual(["b", "a"]);
    store.rename("conn1", "a", "Renamed");
    expect(store.get("conn1", "a")?.title).toBe("Renamed");
    store.delete("conn1", "b");
    expect(store.list("conn1").map((c) => c.id)).toEqual(["a"]);
    expect(() => store.get("conn1", "../x")).toThrow();
  });
  it("folds tool results into the assistant message that called them", () => {
    const items = transcript([
      { role: "user", text: "q" },
      { role: "assistant", text: "", calls: [call("read_file", { path: "a" }, "c1")] },
      { role: "tool", results: [{ id: "c1", name: "read_file", content: "X" }] },
      { role: "assistant", text: "done", calls: [] },
    ]);
    expect(items).toHaveLength(3);
    expect(items[1]!.tools?.[0]?.result).toBe("X");
  });
});

describe("agent loop", () => {
  function scripted(turns: TurnResult[]): ChatProvider & { seen: number[] } {
    const seen: number[] = [];
    return {
      seen,
      listModels: async () => [],
      async turn(req, h) {
        seen.push(req.messages.length);
        const t = turns.shift();
        if (!t) throw new Error("no more scripted turns");
        if (t.text) h.onText(t.text);
        return t;
      },
    };
  }
  const empty = (): Conversation => ({ version: 1, id: "c", title: "t", createdAt: "", updatedAt: "", messages: [{ role: "user", text: "read it" }], usage: { input: 0, output: 0 } });

  it("runs a tool and continues until the model answers", async () => {
    const root = tmp();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const events: AgentEvent[] = [];
    const conv = empty();
    const saves: number[] = [];
    const stop = await runAgent(conv, {
      provider: scripted([
        { text: "", calls: [call("read_file", { path: "a.txt" })], usage: { input: 10, output: 2 }, stop: "tool_use" },
        { text: "It says hello.", calls: [], usage: { input: 20, output: 5 }, stop: "end" },
      ]),
      model: "m",
      system: "",
      maxTokens: 100,
      workspaceTools: true,
      host: host(root),
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      persist: () => saves.push(conv.messages.length),
    });
    expect(stop).toBe("end");
    expect(conv.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(conv.usage).toMatchObject({ input: 30, output: 7 });
    expect(events.filter((e) => e.type === "tool_end")).toHaveLength(1);
    expect(saves.length).toBeGreaterThanOrEqual(3);
  });

  it("stops between tool calls when aborted and still answers every call", async () => {
    const ac = new AbortController();
    const conv = empty();
    const stop = await runAgent(conv, {
      provider: scripted([{ text: "", calls: [call("list_files", {}, "a"), call("list_files", {}, "b")], usage: { input: 1, output: 1 }, stop: "tool_use" }]),
      model: "m",
      system: "",
      maxTokens: 10,
      workspaceTools: true,
      host: { folders: async () => (ac.abort(), []), approve: async () => true },
      signal: ac.signal,
      emit: () => undefined,
      persist: () => undefined,
    });
    expect(stop).toBe("other");
    const tool = conv.messages[conv.messages.length - 1];
    expect(tool?.role === "tool" && tool.results.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
