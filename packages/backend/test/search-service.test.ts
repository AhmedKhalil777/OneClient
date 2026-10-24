import { describe, expect, it } from "vitest";
import type { ConnectionManager } from "../src/connections/connection-manager.js";
import { ContributionRegistry } from "../src/plugins/registry.js";
import { SearchService } from "../src/search/search-service.js";

function setup(invoke: (pluginId: string, kind: "command", target: string, method: string, args: unknown[], connectionId?: string) => Promise<unknown>, ensure: (id: string) => Promise<unknown> = async () => ({})) {
  const registry = new ContributionRegistry();
  registry.addPlugin("files-plugin", { searchProviders: [{ id: "files", label: "Files", command: "files.search", connectionType: "folder", order: 10 }] });
  registry.addPlugin("sql-plugin", { searchProviders: [{ id: "objects", label: "SQL objects", command: "sql.search", order: 20 }] });
  const connections = {
    list: () => [
      { id: "f1", name: "Project", typeId: "folder", pluginId: "files-plugin" },
      { id: "f2", name: "Notes", typeId: "folder", pluginId: "files-plugin" },
      { id: "s1", name: "Prod DB", typeId: "mssql", pluginId: "sql-plugin" },
    ],
    ensureConnected: ensure,
  } as unknown as ConnectionManager;
  return new SearchService(registry, connections, invoke);
}

describe("SearchService", () => {
  it("lists providers by order", () => {
    const s = setup(async () => []);
    expect(s.providers().map((p) => p.id)).toEqual(["files-plugin:files", "sql-plugin:objects"]);
  });

  it("asks the provider's plugin once per connection of its type and tags every hit with its origin", async () => {
    const calls: Array<{ target: string; args: unknown[]; connectionId?: string | undefined }> = [];
    const s = setup(async (_p, _k, target, _m, args, connectionId) => {
      calls.push({ target, args, connectionId });
      return [{ label: "a.ts", openView: { viewId: "files.editor", params: { path: "a.ts" } } }];
    });
    const out = await s.run("files-plugin:files", "  a  ");
    expect(calls.map((c) => c.connectionId).sort()).toEqual(["f1", "f2"]);
    expect(calls[0]).toMatchObject({ target: "files.search", args: [{ query: "a", limit: 20 }] });
    expect(out.hits.map((h) => [h.connectionId, h.connectionName, h.providerId])).toEqual(expect.arrayContaining([["f1", "Project", "files-plugin:files"], ["f2", "Notes", "files-plugin:files"]]));
    expect(out.problems).toEqual([]);
  });

  it("drops malformed results and keeps only bounded, well-formed fields", async () => {
    const s = setup(async () => [
      { label: "ok", description: "x".repeat(1000), openView: { viewId: "v", params: { a: "1", b: 2 } }, evil: "<script>" },
      { label: "", openView: { viewId: "v" } },
      { label: "no action" },
      "junk",
      null,
      { label: "cmd", command: { id: "do.it", args: { n: 1 } } },
    ]);
    const out = await s.run("sql-plugin:objects", "x");
    expect(out.hits.map((h) => h.label)).toEqual(["ok", "cmd"]);
    expect(out.hits[0]!.description!.length).toBeLessThanOrEqual(400);
    expect(out.hits[0]).not.toHaveProperty("evil");
    expect(out.hits[0]!.openView!.params).toEqual({ a: "1" });
  });

  it("reports a failing or unreachable connection as a problem without losing the others", async () => {
    const s = setup(
      async (_p, _k, _t, _m, _a, connectionId) => {
        if (connectionId === "f2") throw new Error("boom");
        return [{ label: "fine", openView: { viewId: "v", params: {} } }];
      },
      async (id) => {
        if (id === "f1") throw new Error("cannot connect");
      },
    );
    const out = await s.run("files-plugin:files", "q");
    expect(out.hits).toHaveLength(0);
    expect(out.problems.map((p) => [p.connectionName, p.message]).sort()).toEqual([["Notes", "boom"], ["Project", "cannot connect"]]);
  });

  it("ignores empty queries and unknown providers", async () => {
    const s = setup(async () => {
      throw new Error("should not be called");
    });
    expect(await s.run("files-plugin:files", "   ")).toEqual({ hits: [], problems: [] });
    expect(await s.run("nope:nope", "x")).toEqual({ hits: [], problems: [] });
  });
});
