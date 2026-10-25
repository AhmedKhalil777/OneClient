/** What the plan view and backend share (type-only: the view bundle imports this file for its types). */

export type PlanMode = "estimated" | "actual";

/** One operator of an execution plan, in the shape every dialect is turned into. */
export interface PlanNode {
  id: number;
  /** "Index Seek", "Hash Join (Left)", "Seq Scan"… */
  op: string;
  /** The table / index the operator reads, "schema.table (index)". */
  object?: string | undefined;
  estRows?: number | undefined;
  actRows?: number | undefined;
  /** The operator's own estimated cost (its subtree's minus its children's), in the database's cost units. */
  cost?: number | undefined;
  /** The operator's own time in ms (actual plans where the database reports it). */
  time?: number | undefined;
  /** Share (0–100) of the whole plan this operator accounts for; by time when known, else by cost. Filled in by `analyzePlan`. */
  percent: number;
  warnings: string[];
  /** Everything else worth showing, in order: predicates, join keys, memory, I/O… */
  props: Array<[string, string]>;
  children: PlanNode[];
}

export interface PlanResult {
  dialect: string;
  mode: PlanMode;
  /** The statement that was analysed (the first one of a script). */
  statement: string;
  root: PlanNode;
  /** Whole-plan facts: total cost, planning / execution time, degree of parallelism… */
  summary: Array<[string, string]>;
  /** Suggestions the database made itself (missing indexes). */
  hints: string[];
  /** The plan as the database printed it (XML / JSON), for the Raw tab and for sharing. */
  raw: string;
  rawKind: "xml" | "json" | "text";
}

/** The dialect's side: runs the statement's plan and converts it. `analyzePlan` finishes the job in the core. */
export interface PlanAccess {
  explain(connectionId: string, database: string | undefined, sql: string, mode: PlanMode): Promise<PlanResult>;
}
