import type { CommandHandler, TreeNode } from "@oneclient/plugin-api";
import { EditError, buildStatements, checkWhere, reviewScript } from "./sql.js";
import { type Change, type LoadedTable, MAX_PAGE_SIZE, PAGE_SIZE, type PageQuery, type TableAccess, type TableColumn, type TableTarget } from "./types.js";

export const TABLE_EDITOR_ICON = "$(table)";

type Params = Record<string, unknown>;
type Answer = { ok: true; data: unknown } | { ok: false; error: string };

export interface TableEditor {
  /** `<prefix>.tableData`: the editor view's backend (load, page, review, apply). */
  command: CommandHandler;
  /** The editor tab of a table — one per table, so opening it again focuses it. */
  tab(target: TableTarget): TreeNode;
  /** The table's columns (cached for a minute; the editor's own reads share it). */
  columns(connectionId: string, target: TableTarget): Promise<TableColumn[]>;
}

const str = (p: Params, key: string): string => {
  const v = p[key];
  if (typeof v !== "string" || !v) throw new EditError(`Missing "${key}".`);
  return v;
};

/** Column metadata is read once per editor session and kept for a minute: pages, review and apply reuse it. */
const CACHE_MS = 60_000;

/**
 * The table data editor (view: `@oneclient/sql-core/ui` `TableEditor`). The dialect supplies `TableAccess`; the core
 * pages, validates, builds the statements for the staged changes and applies them in one transaction.
 */
export function createTableEditor(prefix: string, access: TableAccess, describeError: (err: unknown) => string): TableEditor {
  const cache = new Map<string, { at: number; columns: TableColumn[] }>();

  async function columnsOf(connectionId: string, target: TableTarget, fresh = false): Promise<TableColumn[]> {
    const key = `${connectionId}|${target.database}|${target.schema}|${target.table}`;
    const hit = cache.get(key);
    if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.columns;
    const columns = await access.describe(connectionId, target);
    if (!columns.length) throw new EditError(`${target.schema}.${target.table} was not found (or has no columns you can see).`);
    cache.set(key, { at: Date.now(), columns });
    if (cache.size > 50) cache.delete(cache.keys().next().value!);
    return columns;
  }

  const targetOf = (p: Params): TableTarget => ({ database: str(p, "database"), schema: str(p, "schema"), table: str(p, "table") });

  function pageQuery(p: Params, columns: TableColumn[]): PageQuery {
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(p.limit) || PAGE_SIZE)));
    const offset = Math.max(0, Math.floor(Number(p.offset) || 0));
    const wanted = Array.isArray(p.orderBy) ? (p.orderBy as Array<{ column?: unknown; desc?: unknown }>) : [];
    let orderBy = wanted.map((o) => ({ column: String(o.column), desc: o.desc === true }));
    for (const o of orderBy) if (!columns.some((c) => c.name === o.column)) throw new EditError(`Unknown column "${o.column}".`);
    // Paging needs a stable order: the user's, else the primary key (indexed, so OFFSET stays cheap).
    if (!orderBy.length) orderBy = columns.filter((c) => c.isPk).map((c) => ({ column: c.name, desc: false }));
    return { limit, offset, orderBy, where: checkWhere(typeof p.where === "string" ? p.where : undefined) };
  }

  const methods: Record<string, (cid: string, p: Params) => Promise<unknown>> = {
    /** First page plus everything the grid needs; the row estimate runs beside the page, not before it. */
    async load(cid, p) {
      const target = targetOf(p);
      const columns = await columnsOf(cid, target, true);
      const query = pageQuery(p, columns);
      const [rows, estimatedRows] = await Promise.all([access.fetchPage(cid, target, columns, query), query.where ? Promise.resolve(null) : access.estimateRows(cid, target).catch(() => null)]);
      const hasPk = columns.some((c) => c.isPk);
      const loaded: LoadedTable = { target, columns, readOnlyReason: hasPk ? null : "This table has no primary key, so its rows can't be identified for edits.", rows, estimatedRows, orderBy: query.orderBy };
      return loaded;
    },
    async page(cid, p) {
      const target = targetOf(p);
      const columns = await columnsOf(cid, target);
      const query = pageQuery(p, columns);
      return { rows: await access.fetchPage(cid, target, columns, query), orderBy: query.orderBy };
    },
    /** The SQL the staged changes turn into, for the review dialog (nothing runs). */
    async review(cid, p) {
      const target = targetOf(p);
      const statements = buildStatements(target, await columnsOf(cid, target), (p.changes as Change[]) ?? [], access);
      return { statements: statements.length, rows: statements.reduce((n, s) => n + s.expect, 0), script: reviewScript(statements) };
    },
    async apply(cid, p) {
      const target = targetOf(p);
      const statements = buildStatements(target, await columnsOf(cid, target), (p.changes as Change[]) ?? [], access);
      if (!statements.length) return { statements: 0, rows: 0 };
      await access.apply(cid, target, statements);
      return { statements: statements.length, rows: statements.reduce((n, s) => n + s.expect, 0) };
    },
  };

  return {
    command: {
      commandId: `${prefix}.tableData`,
      async execute(args): Promise<Answer> {
        try {
          const { connectionId, method, params } = (args[0] ?? {}) as { connectionId?: string; method?: string; params?: Params };
          if (!connectionId) throw new EditError("No connection id provided.");
          const fn = methods[String(method)];
          if (!fn) throw new EditError(`Unknown operation "${String(method)}".`);
          return { ok: true, data: await fn(connectionId, params ?? {}) };
        } catch (err) {
          return { ok: false, error: err instanceof EditError ? err.message : describeError(err) };
        }
      },
    },
    columns: (connectionId, target) => columnsOf(connectionId, target),
    tab(target) {
      const title = `${target.schema}.${target.table}`;
      return {
        id: `table:${target.database}:${title}`,
        label: title,
        nodeType: `${prefix}.tableEditor`,
        collapsible: "none",
        openView: { viewId: `${prefix}.tableEditor`, title, params: { ...target }, icon: TABLE_EDITOR_ICON },
      };
    },
  };
}
