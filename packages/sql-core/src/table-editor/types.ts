/** What the table editor's view and backend share (type-only: the view bundle imports this file for its types). */

export type ColumnKind = "text" | "number" | "bool" | "date" | "json" | "binary" | "other";

export interface TableTarget {
  database: string;
  schema: string;
  table: string;
}

export interface TableColumn {
  name: string;
  /** As the database prints it: "int", "nvarchar(50)", "timestamp with time zone". */
  type: string;
  kind: ColumnKind;
  nullable: boolean;
  isPk: boolean;
  /** An identity / serial / default / computed column the database fills in when the insert leaves it out. */
  hasDefault: boolean;
  /** Values can be set on INSERT (false for computed, rowversion, GENERATED ALWAYS). */
  insertable: boolean;
  /** Values can be changed with UPDATE. False for computed, rowversion, identity, and for large columns (shown cut off). */
  editable: boolean;
  /** Can hold large values: those over `LOB_LIMIT` arrive as a `CutValue` and can't be edited (the rest of the column can). */
  lob?: boolean;
}

/** Text / JSON values up to this size are fetched whole; larger ones arrive as a CutValue (a preview) so a page stays fast. */
export const LOB_LIMIT = 65536;
export const LOB_PREVIEW = 2000;

/** A value over LOB_LIMIT: its first LOB_PREVIEW characters and its full size. Read-only in the editor. */
export interface CutValue {
  cut: true;
  preview: string;
  size: number;
}

/** The marker the adapters' SELECT puts in front of a cut value (`<marker>cut:<size>:<preview>`); `cutValue()` turns it into a CutValue. */
export const CUT_MARKER = "cut:";
export function cutValue(v: unknown): unknown {
  if (typeof v !== "string" || !v.startsWith(CUT_MARKER)) return v;
  const rest = v.slice(CUT_MARKER.length);
  const colon = rest.indexOf(":");
  return { cut: true, size: Number(rest.slice(0, colon)) || 0, preview: rest.slice(colon + 1) } satisfies CutValue;
}
export const PAGE_SIZE = 200;
export const MAX_PAGE_SIZE = 1000;

export interface PageQuery {
  limit: number;
  offset: number;
  orderBy: Array<{ column: string; desc: boolean }>;
  /** A condition typed by the user (the part after WHERE); the core has already refused `;` and comments. */
  where?: string | undefined;
}

/** A value from the view: what the user typed (a string), or null, or — for a key — the value read from the row. */
export type CellInput = string | number | boolean | null;

export type Change =
  | { kind: "update"; key: Record<string, CellInput>; set: Record<string, CellInput> }
  | { kind: "insert"; values: Record<string, CellInput> }
  | { kind: "delete"; key: Record<string, CellInput> };

/** One statement of the script, and how many rows it must affect (the apply fails and rolls back otherwise). */
export interface Statement {
  sql: string;
  expect: number;
}

/** A transaction held open for a long write (CSV import): batches run inside it until commit or rollback. */
export interface WriteSession {
  /** Runs the statements in order; rejects when one fails or affects other than `expect` rows (the caller then rolls back). */
  run(statements: Statement[]): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /**
   * Optional fast path for bulk loads: rows go over as data (normalized strings, null = NULL), not as SQL text, so the
   * server doesn't compile a new statement per batch. `supports` says whether it works for these columns.
   */
  fast?: {
    supports(columns: TableColumn[]): Promise<boolean>;
    insert(columns: TableColumn[], rows: Array<Array<string | null>>): Promise<void>;
  };
}

/** The dialect's side of the editor: everything that talks to the database. */
export interface TableAccess {
  quote(name: string): string;
  qualify(target: TableTarget): string;
  literals: {
    /** Prefix for string literals: SQL Server's N'…' keeps Unicode intact. */
    string: string;
    bool: { true: string; false: string };
    /** How the inside of a string literal is escaped. Default: ' doubled. MySQL also needs  doubled. */
    escape?: (text: string) => string;
  };
  describe(connectionId: string, target: TableTarget): Promise<TableColumn[]>;
  /** One page of rows, as arrays in `columns` order, with values over LOB_LIMIT as CutValue. Exact numbers (bigint, decimal) as strings. */
  fetchPage(connectionId: string, target: TableTarget, columns: TableColumn[], query: PageQuery): Promise<unknown[][]>;
  /** Roughly how many rows, from the catalog's statistics (never COUNT(*) on a big table); null when unknown. */
  estimateRows(connectionId: string, target: TableTarget): Promise<number | null>;
  /** Runs the statements in one transaction, in one round trip where the driver allows. Rejects (rolled back) when one affects other than `expect` rows. */
  apply(connectionId: string, target: TableTarget, statements: Statement[]): Promise<void>;
  /** Opens a transaction on its own connection, for imports that run for a while. */
  begin(connectionId: string, target: TableTarget): Promise<WriteSession>;
}

/** What `<prefix>.tableData` `load` / `page` answer. */
export interface LoadedTable {
  target: TableTarget;
  columns: TableColumn[];
  /** Why the table can't be edited (no primary key…); the grid then only reads. */
  readOnlyReason: string | null;
  rows: unknown[][];
  estimatedRows: number | null;
  /** The effective order: the user's, else the primary key. */
  orderBy: PageQuery["orderBy"];
}
