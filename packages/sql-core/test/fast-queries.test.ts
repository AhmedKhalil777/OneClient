import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqlCore } from "../src/core.js";
import { readFastQuery, writeFastQuery } from "../src/fast-queries/file.js";
import { listFastQueries, renameFastQueryFile, writeFastQueryFile } from "../src/fast-queries/store.js";

describe("fast query files (*.query.sql)", () => {
  it("reads the header comments and keeps the script as written", () => {
    const doc = readFastQuery("-- name: Blocking sessions\r\n-- database: Shop\n-- description: Who blocks whom\n\n-- the script's own comment\nSELECT 1;\n\n", "dba/blocking.query.sql");
    expect(doc).toEqual({ name: "Blocking sessions", database: "Shop", description: "Who blocks whom", sql: "-- the script's own comment\nSELECT 1;" });
  });

  it("falls back to the file name, and round-trips", () => {
    const plain = readFastQuery("SELECT * FROM t", "dba/Table-sizes.query.sql");
    expect(plain).toEqual({ name: "Table-sizes", sql: "SELECT * FROM t" });
    const doc = { name: "Sizes", database: "Shop", sql: "SELECT 2" };
    expect(readFastQuery(writeFastQuery(doc), "x.query.sql")).toEqual(doc);
    expect(writeFastQuery({ name: "Two\nlines", sql: "SELECT 3" })).toBe("-- name: Two lines\n\nSELECT 3\n");
  });
});

describe("fast query store and commands", () => {
  let home: string;
  let folder: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "oc-fq-"));
    folder = join(home, "repo");
    await mkdir(join(folder, "dba"), { recursive: true });
    process.env.ONECLIENT_HOME = home;
  });
  afterAll(async () => {
    delete process.env.ONECLIENT_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("lists sub-folders too, renames without clobbering", async () => {
    await writeFile(join(folder, "dba", "waits.query.sql"), "-- name: Waits\nSELECT * FROM sys.dm_os_wait_stats");
    const first = await writeFastQueryFile(folder, { name: "Top customers", database: "Shop", sql: "SELECT TOP 10 * FROM customers" });
    const second = await writeFastQueryFile(folder, { name: "Top customers", sql: "SELECT 1" });
    expect([first, second]).toEqual(["Top-customers.query.sql", "Top-customers-2.query.sql"]);
    expect((await listFastQueries(folder)).map((q) => [q.file, q.name, q.database]).sort()).toEqual([
      ["Top-customers-2.query.sql", "Top customers", undefined],
      ["Top-customers.query.sql", "Top customers", "Shop"],
      ["dba/waits.query.sql", "Waits", undefined],
    ]);
    expect(await renameFastQueryFile(folder, "dba/waits.query.sql", "Wait stats")).toBe("dba/Wait-stats.query.sql");
    expect(await readFile(join(folder, "dba", "Wait-stats.query.sql"), "utf8")).toContain("-- name: Wait stats");
  });

  it("registers only the features that are on, under the plugin's prefix", async () => {
    const base = { prefix: "pg", executeQuery: async () => ({ resultSets: [], messages: [], hasErrors: false, cancelled: false, elapsedMs: 0, database: null, rowsAffected: 0 }), cancelQuery: () => true, ensureConnected: () => undefined };
    const full = createSqlCore(base);
    expect(full.commands.map((c) => c.commandId)).toEqual(expect.arrayContaining(["pg.executeQuery", "pg.history", "pg.attachFastToolsFolder", "pg.saveFastQuery", "pg.runFastQueryOn"]));
    const lean = createSqlCore({ ...base, features: { history: false, fastQueries: false } });
    expect(lean.commands.map((c) => c.commandId).sort()).toEqual(["pg.attachFastToolsFolder", "pg.cancelQuery", "pg.detachFastToolsFolder", "pg.executeQuery"]);
    expect(lean.fastTools?.nodeTypes).toEqual(["pg.fastToolsRoot"]);
    expect(createSqlCore({ ...base, features: { fastTools: false } }).fastTools).toBeUndefined();

    // The section: the attached folder, then the tools; a fast query opens its own (stable) window.
    await full.folders.attach("c1", folder);
    const tree = await full.fastTools!.nodes("c1", { id: "r", label: "c1", nodeType: "pg.fastToolsRoot", collapsible: "expanded" });
    expect(tree.map((n) => n.nodeType)).toEqual(["pg.fastToolsFolder", "pg.fastQueriesRoot"]);
    const groups = await full.fastTools!.nodes("c1", tree[1]!);
    expect(groups.map((g) => g.label)).toEqual(["Shop", "Any database"]);
    const [shop] = await full.fastTools!.nodes("c1", groups[0]!);
    expect(shop).toMatchObject({ label: "Top customers", nodeType: "pg.fastQuery", data: { fastQueryFile: "Top-customers.query.sql", database: "Shop" } });
    expect(shop!.openView).toMatchObject({ viewId: "pg.query", params: { windowId: "fq:Top-customers.query.sql", database: "Shop", fastQueryFile: "Top-customers.query.sql" } });

    const save = full.commands.find((c) => c.commandId === "pg.saveFastQuery")!;
    expect(await save.execute([{ connectionId: "c1", name: "  ", sql: "SELECT 1" }])).toEqual({ ok: false, error: "Give the fast query a name." });
    expect(await save.execute([{ connectionId: "c1", name: "Orders today", sql: "SELECT 1", database: "Shop" }])).toEqual({ ok: true, file: "Orders-today.query.sql", name: "Orders today" });
    const run = (await full.commands.find((c) => c.commandId === "pg.runFastQueryOn")!.execute([{ connectionId: "c1", fastQueryFile: "Orders-today.query.sql", targetDatabase: "Archive" }])) as { openNode: { openView: { params: Record<string, string> } } };
    expect(run.openNode.openView.params).toMatchObject({ database: "Archive", autorun: "1", sql: "SELECT 1" });
  });
});
