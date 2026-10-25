import type { PlanAccess, PlanMode, PlanNode, PlanResult } from "@oneclient/sql-core";
import { PlanError } from "@oneclient/sql-core";
import sql from "mssql";
import { quoteIdent } from "./config.js";
import { splitBatches } from "./query-runner.js";
import { requireSession } from "./sessions.js";

/** SQL Server's execution plans: showplan XML (SET SHOWPLAN_XML for the estimate, SET STATISTICS XML for the actual plan). */

// ---- a small XML reader (showplan is regular: elements and attributes, no text content that matters) ---------------

export interface XEl {
  name: string;
  attrs: Record<string, string>;
  children: XEl[];
}

const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (_, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e.toLowerCase()] ?? (e[1]?.toLowerCase() === "x" ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10))));

export function parseXml(text: string): XEl {
  const root: XEl = { name: "#document", attrs: {}, children: [] };
  const stack: XEl[] = [root];
  const tag = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    if (m[1] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[2] !== undefined) {
      const el: XEl = { name: m[2].replace(/^.*:/, ""), attrs: {}, children: [] };
      for (let a = attr.exec(m[3] ?? ""); a; a = attr.exec(m[3] ?? "")) el.attrs[a[1]!.replace(/^.*:/, "")] = decode(a[2] ?? a[3] ?? "");
      stack[stack.length - 1]!.children.push(el);
      if (m[4] !== "/") stack.push(el);
    }
  }
  return root;
}

const find = (el: XEl, name: string): XEl | undefined => {
  for (const c of el.children) {
    if (c.name === name) return c;
    const deeper = find(c, name);
    if (deeper) return deeper;
  }
  return undefined;
};
const findAll = (el: XEl, name: string, out: XEl[] = []): XEl[] => {
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
};
/** Descendants of `el` that are not inside a nested RelOp: the operator's own details. */
const own = (el: XEl, name: string, out: XEl[] = []): XEl[] => {
  for (const c of el.children) {
    if (c.name === "RelOp") continue;
    if (c.name === name) out.push(c);
    own(c, name, out);
  }
  return out;
};
/** The RelOps directly below `el` (operator children sit inside operator-specific wrappers). */
const childOps = (el: XEl, out: XEl[] = []): XEl[] => {
  for (const c of el.children) {
    if (c.name === "RelOp") out.push(c);
    else childOps(c, out);
  }
  return out;
};

const num = (v: string | undefined): number | undefined => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const unbracket = (s: string | undefined) => s?.replace(/^\[|\]$/g, "");

function objectOf(op: XEl): string | undefined {
  const o = own(op, "Object")[0];
  if (!o) return undefined;
  const parts = [unbracket(o.attrs.Schema), unbracket(o.attrs.Table)].filter(Boolean).join(".");
  const index = unbracket(o.attrs.Index);
  return [parts, index ? `(${index})` : undefined].filter(Boolean).join(" ") || undefined;
}

function counters(op: XEl): { rows?: number; elapsed?: number } {
  const per = own(op, "RunTimeCountersPerThread");
  if (!per.length) return {};
  // With parallelism thread 0 is the coordinator: the workers carry the rows.
  const workers = per.filter((t) => t.attrs.Thread !== "0");
  const used = workers.length ? workers : per;
  return {
    rows: used.reduce((s, t) => s + (num(t.attrs.ActualRows) ?? 0), 0),
    elapsed: Math.max(...per.map((t) => num(t.attrs.ActualElapsedms) ?? 0)),
  };
}

function warningsOf(op: XEl): string[] {
  const out: string[] = [];
  for (const w of own(op, "Warnings")) {
    if (w.attrs.NoJoinPredicate === "true") out.push("No join predicate (a cross join).");
    if (w.attrs.SpatialGuess === "true") out.push("Spatial index guess.");
    for (const c of w.children) {
      if (c.name === "ColumnsWithNoStatistics") out.push(`Columns with no statistics: ${findAll(c, "ColumnReference").map((r) => unbracket(r.attrs.Column)).join(", ")}.`);
      else if (c.name === "SpillToTempDb") out.push(`Spilled to tempdb${c.attrs.SpillLevel ? ` (level ${c.attrs.SpillLevel})` : ""}.`);
      else if (c.name === "Wait") out.push(`Waited ${c.attrs.WaitTime ?? "?"} ms on ${c.attrs.WaitType ?? "a resource"}.`);
      else if (c.name === "PlanAffectingConvert") out.push(`Implicit conversion (${c.attrs.ConvertIssue ?? "?"}) may prevent an index seek: ${c.attrs.Expression ?? ""}`.trim());
      else if (c.name === "MemoryGrantWarning") out.push(`Memory grant: ${c.attrs.GrantWarningKind ?? "warning"}.`);
    }
  }
  return out;
}

function propsOf(op: XEl): Array<[string, string]> {
  const props: Array<[string, string]> = [];
  const scalars = (names: string[]) => names.flatMap((n) => own(op, n)).flatMap((p) => findAll(p, "ScalarOperator")).map((s) => s.attrs.ScalarString).filter((s): s is string => !!s);
  const seek = scalars(["SeekPredicateNew", "SeekPredicate"]);
  const pred = scalars(["Predicate", "ResidualPredicate"]);
  const probe = scalars(["ProbeColumn"]);
  if (seek.length) props.push(["Seek predicate", seek.join(" AND ")]);
  if (pred.length) props.push(["Predicate", pred.join(" AND ")]);
  if (probe.length) props.push(["Probe", probe.join(", ")]);
  const out = own(op, "OutputList")[0];
  if (out) {
    const cols = findAll(out, "ColumnReference").map((c) => unbracket(c.attrs.Column)).filter(Boolean);
    if (cols.length) props.push(["Output", cols.length > 10 ? `${cols.slice(0, 10).join(", ")}, … (${cols.length} columns)` : cols.join(", ")]);
  }
  for (const k of ["EstimateIO", "EstimateCPU", "AvgRowSize", "EstimatedExecutionMode", "Parallel", "EstimateRebinds", "EstimateRewinds"]) if (op.attrs[k] !== undefined) props.push([k, op.attrs[k]!]);
  return props;
}

interface Converted {
  node: PlanNode;
  subtreeCost: number;
  elapsed: number;
}

function convert(op: XEl, ids: { next: number }): Converted {
  const kids = childOps(op).map((c) => convert(c, ids));
  const physical = op.attrs.PhysicalOp ?? "Operator";
  const logical = op.attrs.LogicalOp;
  const subtreeCost = num(op.attrs.EstimatedTotalSubtreeCost) ?? 0;
  const c = counters(op);
  const elapsed = c.elapsed ?? 0;
  const node: PlanNode = {
    id: num(op.attrs.NodeId) ?? ids.next++,
    op: logical && logical !== physical ? `${physical} (${logical})` : physical,
    object: objectOf(op),
    // EstimateRows is per execution; an operator re-run for each outer row (rebinds) produces that many times over.
    estRows: num(op.attrs.EstimateRows) !== undefined ? Math.round(num(op.attrs.EstimateRows)! * (1 + (num(op.attrs.EstimateRebinds) ?? 0))) : undefined,
    actRows: c.rows,
    cost: Math.max(0, subtreeCost - kids.reduce((s, k) => s + k.subtreeCost, 0)),
    time: c.elapsed !== undefined ? Math.max(0, elapsed - kids.reduce((s, k) => s + k.elapsed, 0)) : undefined,
    percent: 0,
    warnings: warningsOf(op),
    props: propsOf(op),
    children: kids.map((k) => k.node),
  };
  return { node, subtreeCost, elapsed };
}

function missingIndexHints(stmt: XEl): string[] {
  return findAll(stmt, "MissingIndexGroup").flatMap((g) => {
    const impact = g.attrs.Impact ? ` (would improve the query by about ${Number(g.attrs.Impact).toFixed(0)}%)` : "";
    return findAll(g, "MissingIndex").map((m) => {
      const cols = (usage: string) => findAll(m, "ColumnGroup").filter((c) => c.attrs.Usage === usage).flatMap((c) => findAll(c, "Column").map((x) => x.attrs.Name!));
      const keys = [...cols("EQUALITY"), ...cols("INEQUALITY")];
      const include = cols("INCLUDE");
      const table = [m.attrs.Database, m.attrs.Schema, m.attrs.Table].filter(Boolean).join(".");
      return `Missing index${impact}: CREATE INDEX [IX_${unbracket(m.attrs.Table)}_${keys.map((k) => unbracket(k)).join("_")}] ON ${table} (${keys.join(", ")})${include.length ? ` INCLUDE (${include.join(", ")})` : ""}`;
    });
  });
}

/** Showplan XML → the shared plan shape. Several statements in the batch: the most expensive one. */
export function planFromXml(xml: string, statement: string, mode: PlanMode): PlanResult {
  const doc = parseXml(xml);
  const stmts = findAll(doc, "StmtSimple").filter((s) => find(s, "QueryPlan"));
  const stmt = stmts.sort((a, b) => (num(b.attrs.StatementSubTreeCost) ?? 0) - (num(a.attrs.StatementSubTreeCost) ?? 0))[0];
  const qp = stmt && find(stmt, "QueryPlan");
  const rootOp = qp?.children.find((c) => c.name === "RelOp");
  if (!stmt || !qp || !rootOp) throw new PlanError("SQL Server produced no plan for this statement (it may not be a query).");
  const { node } = convert(rootOp, { next: 1 });

  const summary: Array<[string, string]> = [["Estimated cost", (num(stmt.attrs.StatementSubTreeCost) ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })]];
  if (stmt.attrs.StatementEstRows) summary.push(["Estimated rows", Math.round(Number(stmt.attrs.StatementEstRows)).toLocaleString()]);
  if (qp.attrs.DegreeOfParallelism) summary.push(["Degree of parallelism", qp.attrs.DegreeOfParallelism]);
  if (qp.attrs.CompileTime) summary.push(["Compile time", `${qp.attrs.CompileTime} ms`]);
  if (stmt.attrs.StatementOptmLevel) summary.push(["Optimization", stmt.attrs.StatementOptmLevel]);
  if (stmts.length > 1) summary.push(["Statements", `${stmts.length} (showing the most expensive)`]);
  const grant = find(qp, "MemoryGrantInfo");
  if (grant?.attrs.GrantedMemory) summary.push(["Memory granted", `${Number(grant.attrs.GrantedMemory).toLocaleString()} KB`]);

  const hints = missingIndexHints(stmt);
  for (const w of qp.children.filter((c) => c.name === "Warnings")) for (const c of w.children) if (c.name === "PlanAffectingConvert") hints.push(`Implicit conversion (${c.attrs.ConvertIssue ?? "?"}): ${c.attrs.Expression ?? ""}`.trim());
  return { dialect: "mssql", mode, statement: stmt.attrs.StatementText?.trim() || statement, root: node, summary, hints, raw: xml, rawKind: "xml" };
}

// ---- running it --------------------------------------------------------------------------------------------------

const SHOWPLAN_COLUMN = /showplan/i;

export const mssqlPlanAccess: PlanAccess = {
  async explain(connectionId, database, script, mode): Promise<PlanResult> {
    const batch = splitBatches(script).find((b) => b.text.trim());
    if (!batch) throw new PlanError("There is no statement to analyse.");
    const statement = batch.text.trim();
    const tx = new sql.Transaction(requireSession(connectionId).pool);
    await tx.begin(); // one connection for all the SET / run / SET steps; always rolled back
    try {
      if (database) await new sql.Request(tx).batch(`USE ${quoteIdent(database)}`);
      let xml: string | undefined;
      if (mode === "estimated") {
        await new sql.Request(tx).batch("SET SHOWPLAN_XML ON");
        try {
          const r = await new sql.Request(tx).batch(statement);
          xml = firstPlan(r.recordsets as unknown as Array<Array<Record<string, unknown>>>);
        } finally {
          // Left on, the pooled connection would hand back plans instead of data for every later query.
          await new sql.Request(tx).batch("SET SHOWPLAN_XML OFF").catch(() => undefined);
        }
      } else {
        const r = await new sql.Request(tx).batch(`SET STATISTICS XML ON;\n${statement}\n;SET STATISTICS XML OFF;`);
        xml = firstPlan(r.recordsets as unknown as Array<Array<Record<string, unknown>>>);
      }
      if (!xml) throw new PlanError("SQL Server returned no plan for this statement.");
      return planFromXml(xml, statement, mode);
    } finally {
      await tx.rollback().catch(() => undefined);
    }
  },
};

/** The showplan XML among a batch's result sets (an actual plan comes after the query's own rows). */
function firstPlan(sets: Array<Array<Record<string, unknown>>>): string | undefined {
  for (const set of [...sets].reverse()) {
    const row = set?.[0];
    if (!row) continue;
    const key = Object.keys(row).find((k) => SHOWPLAN_COLUMN.test(k));
    if (key && typeof row[key] === "string") return row[key] as string;
  }
  return undefined;
}
