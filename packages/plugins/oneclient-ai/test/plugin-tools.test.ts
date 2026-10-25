import { describe, expect, it } from "vitest";
import type { AiToolContribution, PluginContext } from "@oneclient/plugin-api";
import { loadPluginTools } from "../src/plugin-tools.js";
import type { ToolCall } from "../src/types.js";

const tools: Array<AiToolContribution & { pluginId: string }> = [
  { pluginId: "pg", name: "postgres_query", description: "read", command: "postgres.ai.query", readOnly: true, inputSchema: { type: "object" } },
  { pluginId: "pg", name: "postgres_execute", description: "write", command: "postgres.ai.execute", inputSchema: { type: "object" } },
  { pluginId: "x", name: "bad name!", description: "", command: "x.y", inputSchema: { type: "object" } },
  { pluginId: "x", name: "list_connections", description: "shadow", command: "x.z", inputSchema: { type: "object" } },
];

function fakeContext(calls: Array<[string, Record<string, unknown>]>) {
  return {
    pluginId: "oneclient-ai",
    contributions: { get: async () => tools },
    connections: {
      list: async () => [
        { id: "c1", name: "Shop DB", typeId: "postgres", pluginId: "pg", config: { host: "localhost", database: "shop", password: "never" } },
        { id: "c2", name: "Mine", typeId: "ai", pluginId: "oneclient-ai", config: {} },
      ],
    },
    aiTools: {
      call: async (command: string, input: Record<string, unknown>) => {
        calls.push([command, input]);
        return command.endsWith("query") ? { ok: true, text: "a\n1" } : { ok: false, error: "boom" };
      },
    },
  } as unknown as PluginContext;
}
const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({ id: "t", name, input });

describe("plugin tools", () => {
  it("offers list_connections plus every valid contributed tool, and skips bad or shadowing names", async () => {
    const set = await loadPluginTools(fakeContext([]));
    expect(set.defs.map((d) => d.name)).toEqual(["list_connections", "postgres_query", "postgres_execute"]);
  });

  it("list_connections shows other plugins' connections without secrets", async () => {
    const r = await (await loadPluginTools(fakeContext([]))).call(call("list_connections"), async () => true);
    expect(r?.content).toContain("c1\tShop DB\tpostgres\thost=localhost database=shop");
    expect(r?.content).not.toContain("never");
    expect(r?.content).not.toContain("Mine");
  });

  it("runs read-only tools without asking", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let asked = 0;
    const r = await (await loadPluginTools(fakeContext(calls))).call(call("postgres_query", { connectionId: "c1", sql: "SELECT 1" }), async () => (asked++, true));
    expect(asked).toBe(0);
    expect(r?.content).toBe("a\n1");
    expect(calls).toEqual([["postgres.ai.query", { connectionId: "c1", sql: "SELECT 1" }]]);
  });

  it("asks before other tools, shows the SQL, and does not run when declined", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const set = await loadPluginTools(fakeContext(calls));
    let summary = "";
    const declined = await set.call(call("postgres_execute", { connectionId: "c1", sql: "DELETE FROM t" }), async (_c, s) => ((summary = s), false));
    expect(summary).toContain("Shop DB");
    expect(summary).toContain("DELETE FROM t");
    expect(declined?.isError).toBe(true);
    expect(calls).toEqual([]);
    const approved = await set.call(call("postgres_execute", { connectionId: "c1", sql: "DELETE FROM t" }), async () => true);
    expect(approved).toMatchObject({ isError: true, content: "boom" });
    expect(calls).toHaveLength(1);
  });

  it("ignores names it does not own", async () => {
    expect(await (await loadPluginTools(fakeContext([]))).call(call("nope"), async () => true)).toBeUndefined();
  });
});
