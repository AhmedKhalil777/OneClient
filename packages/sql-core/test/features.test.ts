import { describe, expect, it } from "vitest";
import { resolveFeatures } from "../ui/dialect.js";

const dialect = { prefix: "x", productName: "X", gridDialect: "postgres", highlight: (t: string) => t, createCompletion: () => ({ provider: {} as never, invalidate() {} }), schemaChange: /CREATE/i } as const;

describe("SQL core view features", () => {
  it("are all on unless the dialect turns them off", () => {
    expect(resolveFeatures(dialect)).toEqual({ history: true, fastQueries: true, safeMode: true, resultExport: true, cellViewer: true, tableEditor: true, importCsv: true, plan: true });
    expect(resolveFeatures({ ...dialect, features: { history: false, resultExport: false } })).toEqual({ history: false, fastQueries: true, safeMode: true, resultExport: false, cellViewer: true, tableEditor: true, importCsv: true, plan: true });
  });
});

describe("Create Database", () => {
  const base = { prefix: "x", executeQuery: async () => ({}) as never, cancelQuery: () => true, ensureConnected: () => undefined };

  it("is registered only when the dialect can create databases, and is switchable", async () => {
    const { createSqlCore, checkDatabaseName } = await import("../src/core.js");
    const made: string[] = [];
    const create = async (_id: string, name: string, options: Record<string, unknown>) => void made.push(`${name}|${JSON.stringify(options)}`);
    const ids = (c: ReturnType<typeof createSqlCore>) => c.commands.map((x) => x.commandId);
    expect(ids(createSqlCore(base))).not.toContain("x.createDatabase");
    expect(ids(createSqlCore({ ...base, createDatabase: create, features: { createDatabase: false } }))).not.toContain("x.createDatabase");
    const core = createSqlCore({ ...base, createDatabase: create });
    const command = core.commands.find((c) => c.commandId === "x.createDatabase")!;
    expect(await command.execute([{ connectionId: "c", name: "  shop ", collation: "C" }])).toEqual({ ok: true });
    expect(made).toEqual(['shop|{"collation":"C"}']); // trimmed; the form's other fields travel along
    expect(await command.execute([{ connectionId: "c", name: "" }])).toEqual({ ok: false, error: "Give the database a name." });
    expect(() => checkDatabaseName("a".repeat(129))).toThrow(/at most 128/);
    expect(() => checkDatabaseName("bad"+String.fromCharCode(7)+"name")).toThrow(/control/);
    expect(checkDatabaseName(" ok name ")).toBe("ok name");
  });
});
