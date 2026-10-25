/**
 * Fast Aggregates — a table (the aggregate root, say `orders`) with the tables that hang off it (`order_items`, and
 * `tags` through the join table `order_tags`), shown as one editable thing: a paged list of roots, each row opens into
 * a form with its children below, which can be opened in turn. This file is the configuration, shared with the view
 * (type-only: the view bundle imports it for its types).
 */
export const AGGREGATE_VERSION = 1;

export interface TableRef {
  schema: string;
  table: string;
}

export interface ForeignKey {
  name: string;
  /** The table holding the foreign key... */
  table: TableRef;
  columns: string[];
  /** ...and the table it points at. */
  refTable: TableRef;
  refColumns: string[];
}

export interface ColumnLink {
  /** The column on the child side (or the join table). */
  column: string;
  /** The column it matches on the parent (or, for the child side of a join table, on the child). */
  parentColumn: string;
}

/**
 * A table owned by (or related to) its parent entity.
 *  - `oneToMany`: the child table has a foreign key to the parent (`order_items.order_id → orders.id`).
 *  - `manyToMany`: a join table links both (`order_tags.order_id → orders.id`, `order_tags.tag_id → tags.id`).
 */
export interface Relation {
  /** Unique among its siblings; letters, digits, `_` and `-`. */
  id: string;
  label: string;
  kind: "oneToMany" | "manyToMany";
  /** The related entity's table. */
  table: TableRef;
  /** `oneToMany`: `table.column = parent.parentColumn`. */
  link: ColumnLink[];
  /** `manyToMany`: the join table and how it points at the parent and at `table`. Single-column on the child side. */
  via?: { table: TableRef; parent: ColumnLink[]; child: ColumnLink[] };
  /** Columns shown in lists (default: the first few). */
  columns?: string[] | undefined;
  children: Relation[];
}

export interface AggregateConfig {
  version: number;
  name: string;
  description?: string;
  database: string;
  root: {
    table: TableRef;
    label?: string;
    columns?: string[] | undefined;
    children: Relation[];
  };
}

/**
 * A column that points at another table (`orders.customer_id → customers.id`): the form offers the parent's rows to pick
 * from, by a readable column, instead of a raw key. Only single-column foreign keys.
 */
export interface ParentLink {
  column: string;
  refTable: TableRef;
  refColumn: string;
  /** The parent's column that names a row (name, title, …); null when there is none and the key itself is shown. */
  display: string | null;
}

export interface ParentOption {
  /** The value to store in the foreign key column. */
  value: string;
  label: string;
}

/** What `<prefix>.aggregate` `page` answers: one page of an entity's rows. */
export interface AggregatePage {
  columns: Array<{ name: string; type: string; kind: string; nullable: boolean; isPk: boolean; hasDefault: boolean; insertable: boolean; editable: boolean; lob?: boolean }>;
  rows: unknown[][];
  /** There is at least one more row after this page. */
  hasMore: boolean;
  /** Why the rows can't be edited (no primary key), if so. */
  readOnlyReason: string | null;
}
