/**
 * A "faker": how to fill each column of a table. Pure data — saved per table, edited in the Generate Data view,
 * and also imported (type-only) by that view.
 */

export type GeneratorKind =
  /** Leave the column out of the INSERT (its default, NULL or identity applies). */
  | "skip"
  | "null"
  | "constant"
  /** A Bogus-style generator from the catalog (`fakerId`). */
  | "faker"
  | "integer"
  | "decimal"
  | "date"
  | "boolean"
  | "guid"
  /** start, start + step, … */
  | "sequence"
  /** One of a list of values. */
  | "pick"
  /** Random text that fits the column. */
  | "text"
  /** A random existing row of the referenced table. */
  | "fk-existing"
  /** New rows in the referenced table, generated with their own faker (`parent`) — "FK as object". */
  | "fk-new";

export interface ColumnRule {
  column: string;
  kind: GeneratorKind;
  fakerId?: string;
  /** constant value, or "pick" values (one per line / comma separated) */
  value?: string;
  min?: number;
  max?: number;
  /** decimal places for "decimal" */
  decimals?: number;
  /** ISO dates for "date" */
  from?: string;
  to?: string;
  start?: number;
  step?: number;
  /** 0–100: share of rows that get NULL instead (nullable columns only). */
  nullPercent?: number;
  /** For "fk-new": how many parent rows to create (children are spread over them). */
  parentCount?: number;
  /** For "fk-new": the referenced table's own faker. */
  parent?: TableRule;
}

export interface TableRule {
  schema: string;
  table: string;
  /** Columns without a rule get the automatic suggestion at run time. */
  columns: ColumnRule[];
  /** Nested rows generated *for each* row of this table (e.g. a customer's orders) — see ChildRule. */
  children?: ChildRule[];
}

/** Rows of a table that references this one, created per parent row: `via` is the child's foreign key column. */
export interface ChildRule extends TableRule {
  via: string;
  /** Rows per parent: a random number between min and max (inclusive). */
  min: number;
  max: number;
}

export interface GenerateRequest {
  database: string;
  rule: TableRule;
  count: number;
  /** Same seed → same data. */
  seed?: number;
}

export interface GenerateResult {
  /** Rows written (or previewed) per table, parents first. */
  tables: Array<{ schema: string; table: string; rows: number }>;
  /** A few generated rows of the main table, for display. */
  sample: { columns: string[]; rows: unknown[][] };
  /** The first rows of every table the run touched, in generation order (parents, the main table, nested children). */
  samples: TableSample[];
  ms: number;
}

export const MAX_ROWS = 100_000;
export const MAX_DEPTH = 5;

export interface TableSample {
  schema: string;
  table: string;
  /** All rows generated for this table in the run. */
  rows: number;
  /** 0 = the faker's own table; parents and children are 1, 2, … levels away. */
  depth: number;
  /** How it relates to the table that caused it, e.g. "1–3 per Customers row (via customer_id)". Empty for the main table. */
  relation: string;
  columns: string[];
  /** First rows only. Keys the related tables point at come first (e.g. the new id), so the links are visible. */
  sample: unknown[][];
}
