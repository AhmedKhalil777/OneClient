/** What the import view and backend share (type-only: the view bundle imports this file for its types). */

export interface ImportRequest {
  file: string;
  /** One character; empty = detect. */
  delimiter?: string;
  /** The first row holds column names (skipped). */
  header: boolean;
  /** For each CSV column, the table column it fills, or null to skip it. */
  mapping: Array<string | null>;
  /** A blank cell is NULL (where the column allows it) instead of '' / an error. */
  emptyAsNull: boolean;
  /** One transaction for the whole file (default): any bad row, and nothing is imported. */
  allOrNothing: boolean;
}

export interface ImportStatus {
  id: string;
  state: "running" | "done" | "failed" | "cancelled";
  /** Rows sent to the database so far. */
  rows: number;
  /** Rows committed (differs from `rows` only in "commit as you go" mode, or before the final commit). */
  committed: number;
  bytes: number;
  size: number;
  elapsedMs: number;
  error?: string;
}
