import { describe, expect, it } from "vitest";
import { createAiCommands, isReadOnlySql } from "../src/ai-tools.js";

describe("isReadOnlySql", () => {
  it("accepts single read statements", () => {
    for (const sql of ["SELECT * FROM t", "  select 1;", "WITH a AS (SELECT 1) SELECT * FROM a", "SHOW TABLES", "DESCRIBE users", "EXPLAIN SELECT 1", "SELECT 'a; DROP TABLE x' AS s", "SELECT 1 -- ; delete\n", "/* x */ SELECT \"update\" FROM t"]) {
      expect(isReadOnlySql(sql), sql).toBe(true);
    }
  });
  it("refuses everything that could change something", () => {
    for (const sql of ["DELETE FROM t", "SELECT 1; SELECT 2", "SELECT * INTO copy FROM t", "WITH a AS (SELECT 1) DELETE FROM t", "EXPLAIN ANALYZE DELETE FROM t", "SELECT * FROM t FOR UPDATE", "EXEC sp_who", "UPDATE t SET a = 1", "", "   ", "DROP TABLE t", "CALL p()", "SET x = 1", "SELECT 1; DROP TABLE t"]) {
      expect(isReadOnlySql(sql), sql).toBe(false);
    }
  });
});

describe("ai commands", () => {
  const run = (rows: unknown[][], seen: string[] = []) =>
    createAiCommands({
      prefix: "pg",
      ensureConnected: () => undefined,
      describeError: (e) => String(e),
      executeQuery: (async (req: { sql: string }) => {
        seen.push(req.sql);
        return { resultSets: [{ columns: [{ name: "a" }, { name: "b" }], rows, totalRows: rows.length }], messages: [], hasErrors: false, elapsedMs: 3, rowsAffected: 0 };
      }) as never,
    });
  const exec = (cmds: ReturnType<typeof run>, id: string, args: Record<string, unknown>) => cmds.find((c) => c.commandId === `pg.ai.${id}`)!.execute([args], undefined as never) as Promise<{ ok: boolean; text?: string; error?: string }>;

  it("query runs reads and refuses writes without calling the server", async () => {
    const seen: string[] = [];
    const cmds = run([[1, "x"]], seen);
    const ok = await exec(cmds, "query", { connectionId: "c", sql: "SELECT 1" });
    expect(ok.text).toContain("a\tb\n1\tx");
    const bad = await exec(cmds, "query", { connectionId: "c", sql: "DELETE FROM t" });
    expect(bad.ok).toBe(false);
    expect(seen).toEqual(["SELECT 1"]);
  });

  it("execute runs anything (the approval happens in the assistant), and truncates big results", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => [i, "v"]);
    const r = await exec(run(rows), "execute", { connectionId: "c", sql: "UPDATE t SET a = 1", maxRows: 10 });
    expect(r.text).toContain("… 290 more rows not shown");
  });

  it("schema folds columns into one line per table", async () => {
    const cols = [["public", "users", "id", "integer"], ["public", "users", "name", "text"], ["public", "orders", "id", "integer"]];
    const r = await exec(run(cols), "schema", { connectionId: "c" });
    expect(r.text).toBe("public.users(id integer, name text)\npublic.orders(id integer)");
  });

  it("requires a connection id", async () => {
    expect((await exec(run([]), "query", { sql: "SELECT 1" })).ok).toBe(false);
  });
});
