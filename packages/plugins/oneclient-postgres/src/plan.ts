import type { PlanAccess, PlanMode, PlanNode, PlanResult } from "@oneclient/sql-core";
import { PlanError } from "@oneclient/sql-core";
import { splitStatements } from "./query-runner.js";
import { poolFor } from "./sessions.js";

/** PostgreSQL's execution plans: `EXPLAIN (FORMAT JSON)`, with `ANALYZE, BUFFERS` for the actual plan. */

interface PgPlan {
  "Node Type": string;
  "Relation Name"?: string;
  Schema?: string;
  Alias?: string;
  "Index Name"?: string;
  "CTE Name"?: string;
  "Join Type"?: string;
  Strategy?: string;
  "Total Cost"?: number;
  "Plan Rows"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Actual Total Time"?: number;
  Plans?: PgPlan[];
  [key: string]: unknown;
}

/** Keys that are the node's structure (shown elsewhere), not properties. */
const STRUCTURAL = new Set(["Node Type", "Plans", "Relation Name", "Schema", "Alias", "Index Name", "CTE Name", "Plan Rows", "Actual Rows", "Parent Relationship", "Async Capable", "Actual Startup Time", "Subplan Name"]);

const fmt = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(", ") : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));

function convert(p: PgPlan, ids: { next: number }): { node: PlanNode; totalCost: number; totalTime: number } {
  const loops = p["Actual Loops"] ?? 1;
  const kids = (p.Plans ?? []).map((c) => convert(c, ids));
  const totalCost = p["Total Cost"] ?? 0;
  const totalTime = (p["Actual Total Time"] ?? 0) * loops;
  const hasTime = p["Actual Total Time"] !== undefined;

  const detail = p["Join Type"] && /Join|Loop/.test(p["Node Type"]) ? ` (${p["Join Type"]})` : p.Strategy && p["Node Type"] === "Aggregate" ? ` (${p.Strategy})` : "";
  const rel = p["Relation Name"] ? `${p.Schema ? `${p.Schema}.` : ""}${p["Relation Name"]}${p.Alias && p.Alias !== p["Relation Name"] ? ` ${p.Alias}` : ""}` : p["CTE Name"] ? `CTE ${p["CTE Name"]}` : undefined;
  const object = [rel, p["Index Name"] ? `(${p["Index Name"]})` : undefined].filter(Boolean).join(" ") || undefined;

  const warnings: string[] = [];
  if (typeof p["Sort Method"] === "string" && /external/i.test(p["Sort Method"])) warnings.push(`Sort spilled to disk (${p["Sort Method"]}).`);
  if (typeof p["Hash Batches"] === "number" && p["Hash Batches"] > 1) warnings.push(`Hash spilled to disk (${p["Hash Batches"]} batches).`);
  const removed = Number(p["Rows Removed by Filter"] ?? 0) * loops;
  if (/Seq Scan/.test(p["Node Type"]) && removed >= 10_000 && removed > (p["Actual Rows"] ?? 0) * loops * 10) warnings.push(`Reads ${removed.toLocaleString()} rows only to discard them — an index on the filter columns may help.`);

  const props: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(p)) if (!STRUCTURAL.has(k) && v !== undefined && v !== null && v !== "") props.push([k, fmt(v)]);

  const childCost = kids.reduce((s, k) => s + k.totalCost, 0);
  const childTime = kids.reduce((s, k) => s + k.totalTime, 0);
  const node: PlanNode = {
    id: ids.next++,
    op: `${p["Node Type"]}${detail}`,
    object,
    estRows: (p["Plan Rows"] ?? 0) * loops,
    actRows: p["Actual Rows"] !== undefined ? p["Actual Rows"] * loops : undefined,
    cost: Math.max(0, totalCost - childCost),
    time: hasTime ? Math.max(0, totalTime - childTime) : undefined,
    percent: 0,
    warnings,
    props,
    children: kids.map((k) => k.node),
  };
  return { node, totalCost, totalTime };
}

export const postgresPlanAccess: PlanAccess = {
  async explain(connectionId, database, sql, mode: PlanMode): Promise<PlanResult> {
    const statement = splitStatements(sql).find((s) => s.text.trim())?.text.trim();
    if (!statement) throw new PlanError("There is no statement to analyse.");
    const client = await poolFor(connectionId, database).connect();
    try {
      // An actual plan runs the statement: inside a transaction that is always rolled back, so analysing an UPDATE can't change data.
      await client.query("BEGIN");
      const r = await client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (${mode === "actual" ? "ANALYZE, BUFFERS, " : ""}FORMAT JSON) ${statement}`);
      const raw = r.rows[0]?.["QUERY PLAN"];
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      const doc = (JSON.parse(text) as Array<{ Plan: PgPlan; "Planning Time"?: number; "Execution Time"?: number }>)[0];
      if (!doc) throw new PlanError("PostgreSQL returned no plan.");
      const { node, totalCost } = convert(doc.Plan, { next: 0 });
      const summary: Array<[string, string]> = [["Total cost", totalCost.toLocaleString(undefined, { maximumFractionDigits: 2 })]];
      if (doc["Planning Time"] !== undefined) summary.push(["Planning time", `${doc["Planning Time"].toFixed(2)} ms`]);
      if (doc["Execution Time"] !== undefined) summary.push(["Execution time", `${doc["Execution Time"].toFixed(2)} ms`]);
      return { dialect: "postgres", mode, statement, root: node, summary, hints: [], raw: JSON.stringify(JSON.parse(text), null, 2), rawKind: "json" };
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  },
};
