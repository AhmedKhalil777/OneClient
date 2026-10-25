import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzePlan } from "../src/plan/api.js";
import { autoMap, createCsvImporter } from "../src/import/import.js";
import type { PlanResult } from "../src/plan/types.js";
import type { Statement, TableAccess, TableColumn, WriteSession } from "../src/table-editor/types.js";

const col = (name: string, over: Partial<TableColumn> = {}): TableColumn => ({ name, type: "text", kind: "text", nullable: true, isPk: false, hasDefault: false, insertable: true, editable: true, ...over });
const columns: TableColumn[] = [
  col("id", { type: "int", kind: "number", nullable: false, isPk: true, hasDefault: true, insertable: false, editable: false }),
  col("Full Name", { nullable: false }),
  col("age", { type: "int", kind: "number" }),
  col("active", { type: "bit", kind: "bool", nullable: false, hasDefault: true }),
  col("note"),
];

/** A database that records what it was sent; `failAt` makes the n-th batch fail. */
function fakeAccess(opts: { fast?: boolean; failAt?: number } = {}) {
  const log = { statements: [] as Statement[][], fastRows: [] as Array<Array<string | null>>, begun: 0, committed: 0, rolledBack: 0 };
  let batches = 0;
  const access = {
    quote: (n: string) => `"${n}"`,
    qualify: (t: { schema: string; table: string }) => `"${t.schema}"."${t.table}"`,
    literals: { string: "", bool: { true: "true", false: "false" } },
    describe: async () => columns,
    fetchPage: async () => [],
    estimateRows: async () => null,
    apply: async () => undefined,
    async begin(): Promise<WriteSession> {
      log.begun++;
      const maybeFail = () => {
        if (opts.failAt !== undefined && ++batches === opts.failAt) throw new Error("deadlock victim");
      };
      return {
        run: async (s) => (maybeFail(), void log.statements.push(s)),
        commit: async () => void log.committed++,
        rollback: async () => void log.rolledBack++,
        ...(opts.fast
          ? {
              fast: {
                supports: async () => true,
                insert: async (_c: TableColumn[], rows: Array<Array<string | null>>) => (maybeFail(), void log.fastRows.push(...rows)),
              },
            }
          : {}),
      };
    },
  } as TableAccess;
  return { access, log };
}

describe("CSV import", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "oc-imp-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const csv = async (name: string, text: string) => {
    const file = join(dir, name);
    await writeFile(file, text);
    return file;
  };
  const target = { database: "d", schema: "s", table: "t" };

  async function run(access: TableAccess, request: Record<string, unknown>) {
    const importer = createCsvImporter("x", access, (e) => (e as Error).message, async () => columns);
    const call = async (method: string, params: Record<string, unknown>) => importer.command.execute([{ connectionId: "c", method, params: { ...target, ...params } }]) as Promise<{ ok: boolean; data?: any; error?: string }>;
    const started = await call("start", { request });
    if (!started.ok) return { started } as const;
    for (;;) {
      const s = (await call("status", { id: started.data.id })).data;
      if (s.state !== "running") return { started, status: s } as const;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  const base = { delimiter: "", header: true, mapping: [null, "Full Name", "age", "active", "note"], emptyAsNull: true, allOrNothing: true };

  it("maps CSV headers to insertable columns by name, ignoring case, spaces and underscores", () => {
    expect(autoMap(["ID", "full_name", "AGE", "Active", "unknown"], columns)).toEqual([null, "Full Name", "age", "active", null]); // id isn't insertable
    expect(autoMap(["age", "age"], columns)).toEqual(["age", null]); // a column is used once
  });

  it("imports through INSERT statements: normalizes bools, nulls blank numbers, quotes text", async () => {
    const { access, log } = fakeAccess();
    const file = await csv("a.csv", 'id,Full Name,age,active,note\n1,"O\'Brien, Pat",42,yes,"say ""hi"""\n2,Ann,,no,\n');
    const r = await run(access, { ...base, file, mapping: [null, "Full Name", "age", "active", "note"] });
    expect(r.status).toMatchObject({ state: "done", rows: 2, committed: 2 });
    expect(log.statements.flat().map((s) => s.sql)).toEqual([`INSERT INTO "s"."t" ("Full Name", "age", "active", "note") VALUES ('O''Brien, Pat', 42, true, 'say "hi"'), ('Ann', NULL, false, NULL)`]);
    expect([log.begun, log.committed, log.rolledBack]).toEqual([1, 1, 0]);
  });

  it("uses the data fast path when the dialect offers it", async () => {
    const { access, log } = fakeAccess({ fast: true });
    const file = await csv("b.csv", "n,a,b,c,d\nx,1,true,y,\nz,,false,,\n");
    const r = await run(access, { ...base, file, header: false, mapping: [null, "age", "active", "note", null].map((v, i) => (i === 0 ? "Full Name" : v)) });
    expect(r.status).toMatchObject({ state: "failed" }); // the header row ("a") isn't a number
    const ok = await run(access, { ...base, file, header: true, mapping: ["Full Name", "age", "active", "note", null] });
    expect(ok.status).toMatchObject({ state: "done", rows: 2 });
    expect(log.fastRows).toEqual([["x", "1", "true", "y"], ["z", null, "false", null]]);
    expect(log.statements).toEqual([]);
  });

  it("names the row and column of a bad cell, and rolls everything back (all or nothing)", async () => {
    const { access, log } = fakeAccess();
    const rows = Array.from({ length: 50 }, (_, i) => `N${i},${i === 30 ? "twelve" : i},yes,`).join("\n");
    const file = await csv("c.csv", `Full Name,age,active,note\n${rows}\n`);
    const r = await run(access, { ...base, file, mapping: ["Full Name", "age", "active", "note"] });
    expect(r.status).toMatchObject({ state: "failed", committed: 0 });
    expect(r.status!.error).toBe('Row 32: "twelve" is not a number (column "age", int).');
    expect([log.committed, log.rolledBack]).toEqual([0, 1]);
  });

  it("rolls back when the database fails part-way", async () => {
    const { access, log } = fakeAccess({ failAt: 1 });
    const file = await csv("d.csv", `Full Name,age\n${Array.from({ length: 12000 }, (_, i) => `N${i},${i}`).join("\n")}\n`);
    const r = await run(access, { ...base, file, mapping: ["Full Name", "age"] });
    expect(r.status).toMatchObject({ state: "failed" });
    expect(r.status!.error).toMatch(/deadlock victim/);
    expect([log.committed, log.rolledBack]).toEqual([0, 1]);
  });

  it("commits as it goes when asked, and reports what stays", async () => {
    const { access, log } = fakeAccess();
    const lines = Array.from({ length: 25000 }, (_, i) => `N${i},${i === 24000 ? "bad" : i}`);
    const file = await csv("e.csv", `Full Name,age\n${lines.join("\n")}\n`);
    const r = await run(access, { ...base, file, mapping: ["Full Name", "age"], allOrNothing: false });
    expect(r.status).toMatchObject({ state: "failed" });
    // Commits land on the first batch boundary after 10,000 rows (batches here are 4,000 rows): 12,000 and 24,000.
    expect(r.status!.committed).toBe(24000);
    expect(r.status!.error).toMatch(/Row 24002: .*not a number.*24,000 row\(s\) were already committed\./);
    expect(log.committed).toBe(2);
  });

  it("refuses a mapping that can't work before reading the file", async () => {
    const { access } = fakeAccess();
    const file = await csv("f.csv", "a,b\n1,2\n");
    expect((await run(access, { ...base, file, mapping: [null, null] })).started!.error).toMatch(/at least one/);
    expect((await run(access, { ...base, file, mapping: ["age", "age"] })).started!.error).toMatch(/only be filled by one/);
    expect((await run(access, { ...base, file, mapping: ["id", "age"] })).started!.error).toMatch(/can't be imported into/);
    expect((await run(access, { ...base, file, mapping: [null, "age"] })).started!.error).toMatch(/Map a CSV column to "Full Name"/);
    expect((await run(access, { ...base, file: join(dir, "nope.csv"), mapping: ["Full Name", "age"] })).started!.error).toMatch(/doesn't exist/);
  });
});

describe("plan analysis", () => {
  const node = (id: number, over: Record<string, unknown> = {}, children: any[] = []) => ({ id, op: `Op${id}`, percent: 0, warnings: [] as string[], props: [], children, ...over });
  const result = (root: any): PlanResult => ({ dialect: "x", mode: "actual", statement: "", root, summary: [], hints: [], raw: "", rawKind: "json" });

  it("shares work by time when the database reported it, else by cost", () => {
    const byTime = analyzePlan(result(node(1, { time: 10, cost: 90 }, [node(2, { time: 30, cost: 10 })])));
    expect([byTime.root.percent, byTime.root.children[0]!.percent]).toEqual([25, 75]);
    const byCost = analyzePlan(result(node(1, { cost: 90 }, [node(2, { cost: 10 })])));
    expect([byCost.root.percent, byCost.root.children[0]!.percent]).toEqual([90, 10]);
  });

  it("flags a row estimate that is far off, but not small or near ones", () => {
    const p = analyzePlan(result(node(1, { estRows: 10, actRows: 5000 }, [node(2, { estRows: 1, actRows: 40 }), node(3, { estRows: 9000, actRows: 10000 }), node(4, { estRows: 100000, actRows: 3 })])));
    expect(p.root.warnings).toEqual(['Row estimate is off by 500× (estimated 10, actual 5,000) — statistics may be out of date.']);
    expect(p.root.children[0]!.warnings).toEqual([]); // 40× but tiny
    expect(p.root.children[1]!.warnings).toEqual([]);
    expect(p.root.children[2]!.warnings[0]).toMatch(/off by 33,333×/);
  });
});
