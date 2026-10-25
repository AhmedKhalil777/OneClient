import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHistoryStore } from "../src/history.js";

const history = createHistoryStore("postgres");
const recordHistory = history.record;
const listHistory = history.list;
const deleteHistory = history.remove;

describe("query history", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "oc-history-"));
    process.env.ONECLIENT_HOME = home;
  });
  afterAll(async () => {
    delete process.env.ONECLIENT_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("records runs per connection, newest first, and searches them", async () => {
    await recordHistory("c1", { sql: "SELECT * FROM orders", database: "shop", status: "ok", elapsedMs: 12, rows: 3 });
    await recordHistory("c1", { sql: "  DELETE FROM carts WHERE id = 1 ", database: "shop", status: "ok", elapsedMs: 4, rows: 1 });
    await recordHistory("c1", { sql: "SELEC oops", database: "crm", status: "error", elapsedMs: 1, rows: 0, error: "syntax error" });
    await recordHistory("c1", { sql: "   ", database: null, status: "ok", elapsedMs: 0, rows: 0 });
    await recordHistory("c2", { sql: "SELECT 1", database: null, status: "ok", elapsedMs: 0, rows: 1 });

    const all = await listHistory("c1");
    expect(all.map((e) => e.sql)).toEqual(["SELEC oops", "DELETE FROM carts WHERE id = 1", "SELECT * FROM orders"]);
    expect(all[0]).toMatchObject({ status: "error", error: "syntax error", database: "crm" });
    expect((await listHistory("c1", { search: "from shop" })).map((e) => e.sql)).toEqual(["DELETE FROM carts WHERE id = 1", "SELECT * FROM orders"]);
    expect(await listHistory("c2")).toHaveLength(1);
    expect(await readFile(join(home, "postgres", "history", "c1.jsonl"), "utf8")).toContain('"database":"crm"');
  });

  it("deletes one entry or all of them", async () => {
    const [newest] = await listHistory("c1");
    await deleteHistory("c1", newest!.id);
    expect((await listHistory("c1")).map((e) => e.sql)).not.toContain("SELEC oops");
    await deleteHistory("c1");
    expect(await listHistory("c1")).toEqual([]);
    expect(await listHistory("c2")).toHaveLength(1);
  });
});
