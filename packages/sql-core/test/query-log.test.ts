import { describe, expect, it } from "vitest";
import { withQueryLog } from "../src/query-log.js";
import type { ExecuteQueryRequest, QueryRunSummary } from "../src/types.js";

const ok: QueryRunSummary = { resultSets: [{ totalRows: 3 }], messages: [], hasErrors: false, cancelled: false, elapsedMs: 12, database: "db", rowsAffected: 0 };
const req = (sql: string): ExecuteQueryRequest => ({ connectionId: "c", windowId: "w", queryId: "q", database: "shop", sql });
const channel = () => {
  const lines: Array<[string, string, string | undefined]> = [];
  return { lines, log: (level: string, message: string, detail?: string) => void lines.push([level, message, detail]) };
};
const describe_ = (e: unknown) => (e instanceof Error ? e.message : String(e));

describe("withQueryLog", () => {
  it("logs a successful run and returns its result untouched", async () => {
    const ch = channel();
    const r = await withQueryLog(async () => ok, ch as never, describe_)(req("select *\n  from t"));
    expect(r).toBe(ok);
    expect(ch.lines[0]![0]).toBe("info");
    expect(ch.lines[0]![1]).toBe("✓ [shop] select * from t — 1 result set(s), 3 row(s), 0 affected, 12 ms");
    expect(ch.lines[0]![2]).toContain("select *");
  });
  it("logs SQL errors reported in the summary", async () => {
    const ch = channel();
    await withQueryLog(async () => ({ ...ok, hasErrors: true, messages: [{ kind: "error", text: 'relation "x" does not exist' }] }), ch as never, describe_)(req("select * from x"));
    expect(ch.lines[0]![0]).toBe("error");
    expect(ch.lines[0]![1]).toContain('relation "x" does not exist');
  });
  it("logs cancels and thrown errors, and rethrows", async () => {
    const ch = channel();
    await withQueryLog(async () => ({ ...ok, cancelled: true }), ch as never, describe_)(req("select pg_sleep(9)"));
    expect(ch.lines[0]![0]).toBe("warn");
    await expect(withQueryLog(async () => { throw new Error("connection reset"); }, ch as never, describe_)(req("select 1"))).rejects.toThrow("connection reset");
    expect(ch.lines[1]![0]).toBe("error");
    expect(ch.lines[1]![1]).toContain("connection reset");
  });
  it("passes through without a channel and survives a broken one", async () => {
    const run = async () => ok;
    expect(withQueryLog(run, undefined, describe_)).toBe(run);
    const broken = { log: () => { throw new Error("x"); } };
    expect(await withQueryLog(run, broken, describe_)(req("select 1"))).toBe(ok);
  });
});
