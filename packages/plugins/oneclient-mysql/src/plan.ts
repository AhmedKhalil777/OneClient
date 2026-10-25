import type { PlanAccess, PlanMode, PlanNode, PlanResult } from "@oneclient/sql-core";
import { PlanError } from "@oneclient/sql-core";
import { dedicatedConnection } from "./sessions.js";
import { splitStatements } from "./split.js";

/**
 * MySQL's execution plans. The tree format (`EXPLAIN FORMAT=TREE`, and `EXPLAIN ANALYZE` for actual numbers, 8.0.16 /
 * 8.0.18+) is parsed into the shared shape; older servers and MariaDB fall back to the classic tabular EXPLAIN.
 */

interface Raw {
  depth: number;
  text: string;
  cost?: number;
  rows?: number;
  /** Actual: ms until the last row (per loop), rows per loop, loops. */
  time?: number;
  actRows?: number;
  loops?: number;
  never: boolean;
}

const ACTUAL = /\s*\(actual time=([\d.e+-]+)\.\.([\d.e+-]+) rows=([\d.e+-]+) loops=(\d+)\)\s*$/;
const NEVER = /\s*\(never executed\)\s*$/;
const ESTIMATE = /\s*\(cost=([\d.e+-]+) rows=([\d.e+-]+)\)\s*$/;
/** "Index lookup on orders using idx_customer (customer_id=1)", "Table scan on t", "Covering index scan on t using i". */
const ACCESS = /^((?:[\w-]+ )*?(?:scan|lookup|seek|range scan)) on (\S+)(?: using (\S+))?\s*(.*)$/i;

/** The lines of a tree plan, with their nesting depth (4 spaces per level) and numbers. */
export function parseTreeLines(text: string): Raw[] {
  const out: Raw[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\s*)-> (.*)$/.exec(line);
    if (!m) continue;
    let rest = m[2]!.trimEnd();
    const raw: Raw = { depth: Math.floor(m[1]!.length / 4), text: "", never: false };
    if (NEVER.test(rest)) {
      raw.never = true;
      rest = rest.replace(NEVER, "");
    }
    const act = ACTUAL.exec(rest);
    if (act) {
      raw.time = Number(act[2]);
      raw.actRows = Number(act[3]);
      raw.loops = Number(act[4]);
      rest = rest.replace(ACTUAL, "");
    }
    const est = ESTIMATE.exec(rest);
    if (est) {
      raw.cost = Number(est[1]);
      raw.rows = Number(est[2]);
      rest = rest.replace(ESTIMATE, "");
    }
    raw.text = rest.trim();
    out.push(raw);
  }
  return out;
}

function toNode(r: Raw, ids: { next: number }): PlanNode {
  let op = r.text;
  let object: string | undefined;
  const props: Array<[string, string]> = [];
  const access = ACCESS.exec(r.text);
  if (access) {
    op = access[1]!;
    object = `${access[2]}${access[3] ? ` (${access[3]})` : ""}`;
    if (access[4]) props.push(["Condition", access[4].replace(/^\(|\)$/g, "")]);
  } else {
    const colon = r.text.indexOf(": ");
    if (colon > 0) {
      op = r.text.slice(0, colon);
      props.push(["Detail", r.text.slice(colon + 2)]);
    }
  }
  const loops = r.loops ?? 1;
  if (r.loops !== undefined) props.push(["Loops", String(r.loops)]);
  if (r.never) props.push(["Executed", "never"]);
  return {
    id: ids.next++,
    op: op.charAt(0).toUpperCase() + op.slice(1),
    object,
    estRows: r.rows !== undefined ? r.rows * loops : undefined,
    actRows: r.actRows !== undefined ? r.actRows * loops : r.never ? 0 : undefined,
    cost: r.cost,
    time: r.time !== undefined ? r.time * loops : undefined,
    percent: 0,
    warnings: [],
    props,
    children: [],
  };
}

/** Builds the tree from the indented lines, then turns cumulative cost / time into each operator's own. */
export function planFromTree(text: string): PlanNode {
  const lines = parseTreeLines(text);
  if (!lines.length) throw new PlanError("MySQL returned no plan for this statement.");
  const ids = { next: 1 };
  const nodes = lines.map((l) => toNode(l, ids));
  const stack: Array<{ depth: number; node: PlanNode }> = [];
  let root: PlanNode | undefined;
  nodes.forEach((node, i) => {
    const depth = lines[i]!.depth;
    while (stack.length && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) parent.children.push(node);
    else root ??= node;
    stack.push({ depth, node });
  });
  subtractChildren(root!);
  return root!;
}

/** Replaces cumulative cost and time with each operator's own, bottom-up from a copy of the cumulative values. */
function subtractChildren(root: PlanNode): void {
  const cumulative = new Map<PlanNode, { cost?: number | undefined; time?: number | undefined }>();
  const record = (n: PlanNode) => {
    cumulative.set(n, { cost: n.cost, time: n.time });
    n.children.forEach(record);
  };
  record(root);
  const apply = (n: PlanNode) => {
    const mine = cumulative.get(n)!;
    const kids = n.children.map((c) => cumulative.get(c)!);
    if (mine.cost !== undefined) n.cost = Math.max(0, mine.cost - kids.reduce((s, k) => s + (k.cost ?? 0), 0));
    if (mine.time !== undefined) n.time = Math.max(0, mine.time - kids.reduce((s, k) => s + (k.time ?? 0), 0));
    n.children.forEach(apply);
  };
  apply(root);
}

/** The classic tabular EXPLAIN as a flat plan: each row is one table access, in join order. */
function planFromTable(rows: Array<Record<string, unknown>>): PlanNode {
  const children: PlanNode[] = rows.map((r, i) => {
    const props: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(r)) if (v !== null && v !== undefined && !["table", "rows", "type"].includes(k)) props.push([k, String(v)]);
    return {
      id: i + 2,
      op: `${r.type ? String(r.type) : "access"}${r.select_type && r.select_type !== "SIMPLE" ? ` (${String(r.select_type)})` : ""}`,
      object: r.table ? `${String(r.table)}${r.key ? ` (${String(r.key)})` : ""}` : undefined,
      estRows: r.rows !== null && r.rows !== undefined ? Number(r.rows) : undefined,
      percent: 0,
      warnings: String(r.Extra ?? "").match(/Using (filesort|temporary)/g)?.map((w) => `${w} — the server sorts / groups outside an index.`) ?? [],
      props,
      children: [],
    };
  });
  return { id: 1, op: "Query", percent: 0, warnings: [], props: [], children };
}

export const mysqlPlanAccess: PlanAccess = {
  async explain(connectionId, database, sql, mode: PlanMode): Promise<PlanResult> {
    const statement = splitStatements(sql).find((s) => s.text.trim())?.text.trim();
    if (!statement) throw new PlanError("There is no statement to analyse.");
    const conn = await dedicatedConnection(connectionId, database);
    try {
      let root: PlanNode;
      let raw: string;
      const summary: Array<[string, string]> = [];
      if (mode === "actual") {
        // ANALYZE runs the statement: inside a transaction that is always rolled back (DDL and other implicit commits can't be undone).
        await conn.query("START TRANSACTION");
        try {
          const [rows] = (await conn.query(`EXPLAIN ANALYZE ${statement}`)) as unknown as [Array<Record<string, string>>];
          raw = Object.values(rows[0] ?? {})[0] ?? "";
        } catch (err) {
          if ((err as { code?: string }).code === "ER_PARSE_ERROR" && !/^\s*(select|with|update|delete|insert|table|values)/i.test(statement)) throw err;
          if ((err as { code?: string }).code === "ER_PARSE_ERROR") throw new PlanError("Actual plans need MySQL 8.0.18 or newer (the estimated plan works on older servers and MariaDB).");
          throw err;
        } finally {
          await conn.query("ROLLBACK").catch(() => undefined);
        }
        root = planFromTree(raw);
        if (root.time !== undefined) summary.push(["Execution time", `${root.time.toLocaleString(undefined, { maximumFractionDigits: 2 })} ms`]);
      } else {
        try {
          const [rows] = (await conn.query(`EXPLAIN FORMAT=TREE ${statement}`)) as unknown as [Array<Record<string, string>>];
          raw = Object.values(rows[0] ?? {})[0] ?? "";
          root = planFromTree(raw);
        } catch (err) {
          if ((err as { code?: string }).code !== "ER_PARSE_ERROR") throw err;
          // MariaDB and servers before 8.0.16: the tabular plan.
          const [rows] = (await conn.query(`EXPLAIN ${statement}`)) as unknown as [Array<Record<string, unknown>>];
          raw = JSON.stringify(rows, null, 2);
          root = planFromTable(rows);
          summary.push(["Format", "tabular (this server has no tree plans)"]);
          return { dialect: "mysql", mode, statement, root, summary, hints: [], raw, rawKind: "json" };
        }
      }
      const total = (n: PlanNode): number => (n.cost ?? 0) + n.children.reduce((s, c) => s + total(c), 0);
      summary.unshift(["Estimated cost", total(root).toLocaleString(undefined, { maximumFractionDigits: 2 })]);
      return { dialect: "mysql", mode, statement, root, summary, hints: [], raw, rawKind: "text" };
    } finally {
      await conn.end().catch(() => undefined);
    }
  },
};
