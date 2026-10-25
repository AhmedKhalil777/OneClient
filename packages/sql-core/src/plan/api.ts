import type { CommandHandler } from "@oneclient/plugin-api";
import type { PlanAccess, PlanMode, PlanNode, PlanResult } from "./types.js";

/** A plan is the user's own statement analysed; this is the message for what they can fix. */
export class PlanError extends Error {}

/** How far off (a factor) a row estimate must be before it is flagged. */
const MISESTIMATE = 10;

/**
 * Finishes what the dialect parsed: each operator's share of the plan (by its own time when the database reported it,
 * else by its own estimated cost), and a warning where the optimizer's row estimate was far from what happened.
 */
export function analyzePlan(result: PlanResult): PlanResult {
  const all: PlanNode[] = [];
  const walk = (n: PlanNode) => {
    all.push(n);
    n.children.forEach(walk);
  };
  walk(result.root);
  const totalTime = all.reduce((s, n) => s + (n.time ?? 0), 0);
  const totalCost = all.reduce((s, n) => s + (n.cost ?? 0), 0);
  for (const n of all) {
    n.percent = totalTime > 0 ? ((n.time ?? 0) / totalTime) * 100 : totalCost > 0 ? ((n.cost ?? 0) / totalCost) * 100 : 0;
    if (n.estRows !== undefined && n.actRows !== undefined) {
      const est = Math.max(n.estRows, 1);
      const act = Math.max(n.actRows, 1);
      const factor = Math.max(est / act, act / est);
      if (factor >= MISESTIMATE && Math.max(est, act) >= 100) {
        n.warnings.push(`Row estimate is off by ${factor >= 1000 ? `${Math.round(factor).toLocaleString()}` : factor.toFixed(0)}× (estimated ${Math.round(n.estRows).toLocaleString()}, actual ${Math.round(n.actRows).toLocaleString()}) — statistics may be out of date.`);
      }
    }
  }
  return result;
}

export interface Planner {
  /** `<prefix>.explain`: the view's backend. */
  command: CommandHandler;
}

export function createPlanner(prefix: string, access: PlanAccess, describeError: (err: unknown) => string): Planner {
  return {
    command: {
      commandId: `${prefix}.explain`,
      async execute(args) {
        try {
          const { connectionId, database, sql, mode } = (args[0] ?? {}) as { connectionId?: string; database?: string; sql?: string; mode?: string };
          if (!connectionId) throw new PlanError("No connection id provided.");
          if (!sql?.trim()) throw new PlanError("There is no statement to analyse.");
          const m: PlanMode = mode === "actual" ? "actual" : "estimated";
          return { ok: true, data: analyzePlan(await access.explain(connectionId, database || undefined, sql, m)) };
        } catch (err) {
          return { ok: false, error: err instanceof PlanError ? err.message : describeError(err) };
        }
      },
    },
  };
}
