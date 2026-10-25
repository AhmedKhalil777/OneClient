import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzePlan } from "@oneclient/sql-core";
import { describe, expect, it } from "vitest";
import { parseXml, planFromXml } from "../src/plan.js";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const flat = (n: { children: unknown[] }, out: Array<Record<string, unknown>> = []) => (out.push(n as unknown as Record<string, unknown>), (n.children as Array<{ children: unknown[] }>).forEach((c) => flat(c, out)), out);

describe("showplan XML reader", () => {
  it("reads elements and attributes, decodes entities, ignores prolog, comments and text", () => {
    const doc = parseXml(`<?xml version="1.0"?><!-- c --><A x="1 &lt; 2" y='q&amp;a'><B/><C z="&#65;&#x42;">text<D/></C></A>`);
    const a = doc.children[0]!;
    expect(a.name).toBe("A");
    expect(a.attrs).toEqual({ x: "1 < 2", y: "q&a" });
    expect(a.children.map((c) => c.name)).toEqual(["B", "C"]);
    expect(a.children[1]!.attrs.z).toBe("AB");
    expect(a.children[1]!.children[0]!.name).toBe("D");
  });
});

describe("SQL Server plans (real showplan XML from the server)", () => {
  it("turns an estimated plan into the shared tree: operators, objects, estimates, index hints", () => {
    const plan = analyzePlan(planFromXml(fixture("plan-estimated.xml"), "SELECT …", "estimated"));
    expect(plan.dialect).toBe("mssql");
    expect(plan.rawKind).toBe("xml");
    const ops = flat(plan.root).map((n) => n.op);
    expect(ops[0]).toBe("Sort");
    expect(ops).toEqual(expect.arrayContaining(["Merge Join (Inner Join)", "Clustered Index Scan"]));
    const scan = flat(plan.root).find((n) => n.op === "Clustered Index Scan" && String(n.object).includes("oc_cap_o"))!;
    expect(String(scan.object)).toMatch(/^dbo\.oc_cap_o \(PK__/);
    expect(scan.estRows).toBeGreaterThan(0);
    expect(scan.actRows).toBeUndefined(); // an estimated plan has no actual counts
    expect(plan.summary.map(([k]) => k)).toEqual(expect.arrayContaining(["Estimated cost", "Estimated rows"]));
    expect(plan.hints[0]).toMatch(/^Missing index \(would improve the query by about \d+%\): CREATE INDEX \[IX_oc_cap_o_status\] ON \[tempdb\]\.\[dbo\]\.\[oc_cap_o\] \(\[status\]\) INCLUDE \(\[customer_id\]/);
  });

  it("splits the cost between operators: shares add up to 100% and the scan of the big table leads", () => {
    const plan = analyzePlan(planFromXml(fixture("plan-estimated.xml"), "", "estimated"));
    const all = flat(plan.root) as unknown as Array<{ op: string; object?: string; percent: number }>;
    expect(all.reduce((s, n) => s + n.percent, 0)).toBeCloseTo(100, 5);
    const top = [...all].sort((a, b) => b.percent - a.percent)[0]!;
    expect(top.object).toContain("oc_cap_o");
  });

  it("reads actual row counts and times from an actual plan, and flags a bad estimate", () => {
    const plan = analyzePlan(planFromXml(fixture("plan-actual.xml"), "", "actual"));
    const all = flat(plan.root) as unknown as Array<{ op: string; object?: string; actRows?: number; time?: number; estRows?: number; warnings: string[] }>;
    // (Compute Scalar and a few others have no runtime counters in SQL Server plans.)
    expect(all.filter((n) => n.actRows !== undefined).length).toBeGreaterThanOrEqual(all.length - 1);
    const scanC = all.find((n) => n.object?.includes("oc_cap_c"))!;
    expect(scanC.actRows).toBe(496);
    expect(all.some((n) => (n.time ?? 0) > 0)).toBe(true);
    expect(all.flatMap((n) => n.warnings).some((w) => /Row estimate is off by \d+×/.test(w))).toBe(true);
  });

  it("explains when there is nothing to show", () => {
    expect(() => planFromXml('<ShowPlanXML><BatchSequence><Batch><Statements><StmtSimple StatementText="SET X ON"/></Statements></Batch></BatchSequence></ShowPlanXML>', "", "estimated")).toThrow(/no plan/);
  });
});
