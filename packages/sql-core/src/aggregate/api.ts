import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { CommandHandler, TreeNode } from "@oneclient/plugin-api";
import { findFiles, freeName, inFolder, type FolderStore } from "../fast-tools/folder.js";
import { EditError, buildStatements, checkWhere, literal } from "../table-editor/sql.js";
import { MAX_PAGE_SIZE, type PageQuery, type Statement, type TableAccess, type TableColumn, type TableTarget } from "../table-editor/types.js";
import { sameTable } from "./model.js";
import { candidateFilter, childFilter, justInsertedFilter, normalizeAggregate, optionLabel, parentFilter, parentLinks, searchFilter, suggestAggregate, validateAggregate } from "./model.js";
import type { AggregateConfig, AggregatePage, ForeignKey, ParentOption, Relation, TableRef } from "./types.js";

export const AGGREGATE_EXT = ".aggregate.json";
export const AGGREGATE_ICON = "$(cube)";
const PAGE = 25;

type Params = Record<string, unknown>;
type Answer = { ok: true; data: unknown } | { ok: false; error: string };

export interface FastAggregates {
  /** Children of `<prefix>.fastAggregatesRoot`. */
  nodes(folder: string): Promise<TreeNode[]>;
  /** `<prefix>.aggregate`: the aggregate view's backend. */
  command: CommandHandler;
  /** The editor tab of an aggregate file. */
  tab(file: string, name: string): TreeNode;
  /** Builds a configuration for a table from the database's foreign keys and saves it as a new file. */
  create(connectionId: string, root: TableTarget): Promise<{ file: string; name: string }>;
  rename(connectionId: string, file: string, name: string): Promise<void>;
  remove(connectionId: string, file: string): Promise<void>;
}

interface Entry {
  file: string;
  config: AggregateConfig;
}

async function readConfig(root: string, file: string): Promise<AggregateConfig> {
  return normalizeAggregate(JSON.parse(await readFile(inFolder(root, file), "utf-8")));
}

async function writeConfig(root: string, file: string, config: AggregateConfig): Promise<void> {
  const abs = inFolder(root, file);
  await writeFile(`${abs}.tmp`, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  await rename(`${abs}.tmp`, abs);
}

const str = (p: Params, key: string): string => {
  const v = p[key];
  if (typeof v !== "string" || !v) throw new EditError(`Missing "${key}".`);
  return v;
};
const tableOf = (p: Params): TableRef => ({ schema: str(p, "schema"), table: str(p, "table") });

/**
 * Fast Aggregates (FAST TOOLS ▸ Fast Aggregates): configuration files (`*.aggregate.json`) describing a root table and
 * the tables hanging off it. The aggregate view reads and writes rows through the same table access the table data
 * editor uses; this module adds the configuration, the foreign-key discovery and the filters that select a parent's
 * children.
 */
export function createFastAggregates(
  prefix: string,
  folders: FolderStore,
  access: TableAccess,
  columnsOf: (connectionId: string, target: TableTarget) => Promise<TableColumn[]>,
  describeError: (err: unknown) => string,
): FastAggregates {
  const viewId = `${prefix}.aggregate`;

  const tab = (file: string, name: string): TreeNode => ({
    id: `aggregate:${file}`,
    label: name,
    nodeType: `${prefix}.fastAggregate`,
    collapsible: "none",
    icon: AGGREGATE_ICON,
    openView: { viewId, title: name, icon: AGGREGATE_ICON, params: { file } },
  });

  async function list(root: string): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const file of await findFiles(root, AGGREGATE_EXT)) {
      try {
        out.push({ file, config: await readConfig(root, file) });
      } catch {
        /* unreadable or not JSON: skip */
      }
    }
    return out.sort((a, b) => a.config.name.localeCompare(b.config.name, undefined, { sensitivity: "base" }));
  }

  /** Columns of any table of the aggregate, for the filters (cached by the table editor's own cache). */
  async function prefetch(connectionId: string, database: string, tables: TableRef[]): Promise<(t: TableRef) => TableColumn[]> {
    const map = new Map<string, TableColumn[]>();
    for (const t of tables) map.set(`${t.schema}.${t.table}`, await columnsOf(connectionId, { database, ...t }));
    return (t) => {
      const c = map.get(`${t.schema}.${t.table}`);
      if (!c) throw new EditError(`${t.schema}.${t.table} was not loaded.`);
      return c;
    };
  }

  /** Foreign keys per database, kept for a minute: every form opens with a `parents` call. */
  const fkCache = new Map<string, { at: number; fks: ForeignKey[] }>();
  async function foreignKeysOf(connectionId: string, database: string): Promise<ForeignKey[]> {
    if (!access.foreignKeys) return [];
    const key = `${connectionId}|${database}`;
    const hit = fkCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.fks;
    const fks = await access.foreignKeys(connectionId, database);
    fkCache.set(key, { at: Date.now(), fks });
    if (fkCache.size > 20) fkCache.delete(fkCache.keys().next().value!);
    return fks;
  }

  const relationTables = (r: Relation): TableRef[] => [r.table, ...(r.via ? [r.via.table] : [])];

  async function suggest(connectionId: string, database: string, rootTable: TableRef): Promise<AggregateConfig> {
    if (!access.foreignKeys) throw new EditError("This database connection can't read foreign keys.");
    const fks = await access.foreignKeys(connectionId, database);
    // Which tables are join tables needs their primary keys; only tables with exactly two foreign keys can be.
    const counts = new Map<string, { table: TableRef; n: number }>();
    for (const fk of fks) {
      const k = `${fk.table.schema}.${fk.table.table}`;
      counts.set(k, { table: fk.table, n: (counts.get(k)?.n ?? 0) + 1 });
    }
    const pk = new Map<string, string[]>();
    for (const { table, n } of counts.values()) {
      if (n !== 2) continue;
      try {
        pk.set(`${table.schema}.${table.table}`, (await columnsOf(connectionId, { database, ...table })).filter((c) => c.isPk).map((c) => c.name));
      } catch {
        /* a table we can't describe is not a join table for us */
      }
    }
    return suggestAggregate(database, rootTable, fks as ForeignKey[], pk);
  }

  /** `page` for the root list, or for a relation of an opened parent row (the filter comes from the relation, not from the user). */
  async function page(connectionId: string, p: Params): Promise<AggregatePage> {
    const database = str(p, "database");
    const table = tableOf(p);
    const target: TableTarget = { database, ...table };
    const columns = await columnsOf(connectionId, target);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(p.limit) || PAGE)));
    const offset = Math.max(0, Math.floor(Number(p.offset) || 0));

    let where: string | undefined;
    const relation = p.relation as Relation | undefined;
    if (relation && (relation.table.schema !== table.schema || relation.table.table !== table.table)) throw new EditError("The relation doesn't match the table.");
    const parentValues = (p.parentValues ?? {}) as Record<string, unknown>;
    if (relation) {
      const lookup = await prefetch(connectionId, database, relationTables(relation));
      where = p.candidates === true ? candidateFilter(relation, parentValues, lookup, access, { database }) : childFilter(relation, parentValues, lookup, access, { database });
      const extra = checkWhere(typeof p.filter === "string" ? p.filter : undefined);
      if (extra) where = `(${where}) AND (${extra})`;
    } else {
      where = checkWhere(typeof p.filter === "string" ? p.filter : undefined);
    }

    // `search`: plain words over the text columns (the simple box; `filter` is the SQL condition behind "Advanced").
    const searched = typeof p.search === "string" ? searchFilter(columns, p.search, access) : undefined;
    if (searched) where = where ? `(${where}) AND ${searched}` : searched;
    // `by`: rows whose column equals a value — what a foreign key points at (not always the primary key).
    if (p.by && typeof p.by === "object") {
      const by = p.by as { column?: unknown; value?: unknown };
      const c = columns.find((x) => x.name === by.column);
      if (!c) throw new EditError(`Unknown column "${String(by.column)}".`);
      if (by.value === null || by.value === undefined) throw new EditError(`No value for "${c.name}".`);
      const eq = `${access.quote(c.name)} = ${literal(typeof by.value === "string" || typeof by.value === "number" || typeof by.value === "boolean" ? by.value : String(by.value), c, access)}`;
      where = where ? `(${where}) AND ${eq}` : eq;
    }
    // `key`: just this row, by primary key (how the form re-reads a row after saving it).
    if (p.key && typeof p.key === "object") {
      const key = p.key as Record<string, unknown>;
      const parts = columns
        .filter((c) => c.isPk)
        .map((c) => {
          const v = key[c.name];
          if (v === null || v === undefined) throw new EditError(`The row has no value for key column "${c.name}".`);
          return `${access.quote(c.name)} = ${literal(typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v), c, access)}`;
        });
      if (parts.length) where = where ? `(${where}) AND ${parts.join(" AND ")}` : parts.join(" AND ");
    }

    const wanted = Array.isArray(p.orderBy) ? (p.orderBy as Array<{ column?: unknown; desc?: unknown }>) : [];
    let orderBy = wanted.map((o) => ({ column: String(o.column), desc: o.desc === true }));
    for (const o of orderBy) if (!columns.some((c) => c.name === o.column)) throw new EditError(`Unknown column "${o.column}".`);
    if (!orderBy.length) orderBy = columns.filter((c) => c.isPk).map((c) => ({ column: c.name, desc: false }));
    // One row more than asked tells whether there is a next page without counting the table.
    const query: PageQuery = { limit: limit + 1, offset, orderBy, where };
    const rows = await access.fetchPage(connectionId, target, columns, query);
    const hasPk = columns.some((c) => c.isPk);
    return {
      columns,
      rows: rows.slice(0, limit),
      hasMore: rows.length > limit,
      readOnlyReason: hasPk ? null : "This table has no primary key, so its rows can't be identified for edits.",
    };
  }

  const keyOf = (columns: TableColumn[], values: Record<string, unknown>): Record<string, string | number | boolean> => {
    const key: Record<string, string | number | boolean> = {};
    for (const c of columns.filter((x) => x.isPk)) {
      const v = values[c.name];
      if (v === null || v === undefined) throw new EditError(`The row has no value for key column "${c.name}".`);
      key[c.name] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v);
    }
    return key;
  };

  /** How many related rows of each relation a parent row has — up to 100, so a huge table stays cheap ("100+" in the view). */
  async function counts(connectionId: string, p: Params): Promise<Record<string, { n: number; more: boolean }>> {
    const database = str(p, "database");
    const parentValues = (p.parentValues ?? {}) as Record<string, unknown>;
    const relations = (Array.isArray(p.relations) ? p.relations : []) as Relation[];
    const out: Record<string, { n: number; more: boolean }> = {};
    for (const r of relations) {
      try {
        const target: TableTarget = { database, ...r.table };
        const columns = await columnsOf(connectionId, target);
        const lookup = await prefetch(connectionId, database, relationTables(r));
        const where = childFilter(r, parentValues, lookup, access, { database });
        // One narrow column is enough to count rows.
        const one = columns.filter((c) => c.isPk).slice(0, 1).concat(columns.slice(0, 1))[0]!;
        const rows = await access.fetchPage(connectionId, target, [one], { limit: 101, offset: 0, orderBy: [{ column: one.name, desc: false }], where });
        out[r.id] = { n: Math.min(rows.length, 100), more: rows.length > 100 };
      } catch {
        /* a count that can't be read is just not shown */
      }
    }
    return out;
  }

  /**
   * Everything that goes when a row is deleted *with* its related rows: its one-to-many children and theirs (deepest
   * first, so no foreign key is broken on the way), and the join-table links of its many-to-many relations (the related
   * rows themselves stay). One list of statements for one transaction, with how many rows each relation contributes.
   */
  const MAX_CASCADE_ROWS = 5000;
  const MAX_CASCADE_QUERIES = 400;
  async function collectDelete(connectionId: string, database: string, relations: Relation[], parentValues: Record<string, unknown>, path: string[], st: { statements: Statement[]; items: Map<string, number>; rows: number; queries: number }): Promise<void> {
    for (const r of relations) {
      if (++st.queries > MAX_CASCADE_QUERIES) throw new EditError("This row has too many levels of related rows to delete in one go.");
      const label = [...path, r.label].join(" › ");
      const target: TableTarget = { database, ...r.table };
      const columns = await columnsOf(connectionId, target);
      const lookup = await prefetch(connectionId, database, relationTables(r));
      const where = childFilter(r, parentValues, lookup, access, { database });
      const order = columns.filter((c) => c.isPk).map((c) => ({ column: c.name, desc: false }));
      const rows = await access.fetchPage(connectionId, target, columns, { limit: MAX_CASCADE_ROWS + 1, offset: 0, orderBy: order.length ? order : [{ column: columns[0]!.name, desc: false }], where });
      if (rows.length > MAX_CASCADE_ROWS) throw new EditError(`${label} has more than ${MAX_CASCADE_ROWS} rows — too many to delete at once.`);
      if (rows.length === 0) continue;

      if (r.kind === "manyToMany") {
        const via = r.via!;
        const joinCols = await columnsOf(connectionId, { database, ...via.table });
        const conds = via.parent.map((l) => {
          const c = joinCols.find((x) => x.name === l.column);
          const v = parentValues[l.parentColumn];
          if (!c || v === null || v === undefined) throw new EditError(`The join table of ${r.label} is not set up for this row.`);
          return `${access.quote(c.name)} = ${literal(typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v), c, access)}`;
        });
        st.statements.push({ sql: `DELETE FROM ${access.qualify({ database, ...via.table })} WHERE ${conds.join(" AND ")}`, expect: rows.length });
        st.items.set(`${label} (links only)`, (st.items.get(`${label} (links only)`) ?? 0) + rows.length);
        continue;
      }

      const records = rows.map((row) => Object.fromEntries(columns.map((c, i) => [c.name, row[i]])));
      for (const rec of records) await collectDelete(connectionId, database, r.children, rec, [...path, r.label], st);
      if (!columns.some((c) => c.isPk)) throw new EditError(`${label} has no primary key, so its rows can't be deleted safely.`);
      st.statements.push(...buildStatements(target, columns, records.map((rec) => ({ kind: "delete" as const, key: keyOf(columns, rec) })), access));
      st.items.set(label, (st.items.get(label) ?? 0) + rows.length);
      st.rows += rows.length;
      if (st.rows > MAX_CASCADE_ROWS) throw new EditError(`More than ${MAX_CASCADE_ROWS} related rows — too many to delete at once.`);
    }
  }

  async function deletePlan(connectionId: string, p: Params, run: boolean): Promise<{ items: Array<{ label: string; count: number }>; total: number }> {
    const database = str(p, "database");
    const table = tableOf(p);
    const target: TableTarget = { database, ...table };
    const columns = await columnsOf(connectionId, target);
    const values = (p.values ?? {}) as Record<string, unknown>;
    const relations = (Array.isArray(p.relations) ? p.relations : []) as Relation[];
    const st = { statements: [] as Statement[], items: new Map<string, number>(), rows: 0, queries: 0 };
    await collectDelete(connectionId, database, relations, values, [], st);
    st.statements.push(...buildStatements(target, columns, [{ kind: "delete", key: keyOf(columns, values) }], access));
    if (run) await access.apply(connectionId, target, st.statements);
    const items = [...st.items.entries()].map(([label, count]) => ({ label, count }));
    return { items, total: items.reduce((n, i) => n + i.count, 0) + 1 };
  }

  /** Link / unlink rows of a many-to-many relation: plain statements against the join table. */
  async function joinStatements(connectionId: string, p: Params, mode: "link" | "unlink"): Promise<Statement[]> {
    const database = str(p, "database");
    const relation = p.relation as Relation | undefined;
    if (!relation || relation.kind !== "manyToMany" || !relation.via) throw new EditError("This relation has no join table.");
    const parentValues = (p.parentValues ?? {}) as Record<string, unknown>;
    const children = Array.isArray(p.children) ? (p.children as Array<Record<string, unknown>>) : [];
    if (!children.length) throw new EditError("Choose at least one row.");
    const via = relation.via;
    const joinCols = await columnsOf(connectionId, { database, ...via.table });
    const col = (name: string) => {
      const c = joinCols.find((x) => x.name === name);
      if (!c) throw new EditError(`Unknown column "${name}" in the join table.`);
      return c;
    };
    const valueOf = (v: unknown, what: string, name: string) => {
      if (v === null || v === undefined) throw new EditError(`The ${what} row has no value for "${name}".`);
      return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v);
    };
    const table = access.qualify({ database, ...via.table });
    return children.map((child): Statement => {
      const pairs: Array<[TableColumn, string | number | boolean]> = [
        ...via.parent.map((l): [TableColumn, string | number | boolean] => [col(l.column), valueOf(parentValues[l.parentColumn], "parent", l.parentColumn)]),
        ...via.child.map((l): [TableColumn, string | number | boolean] => [col(l.column), valueOf(child[l.parentColumn], "related", l.parentColumn)]),
      ];
      if (mode === "link") {
        return { sql: `INSERT INTO ${table} (${pairs.map(([c]) => access.quote(c.name)).join(", ")}) VALUES (${pairs.map(([c, v]) => literal(v, c, access)).join(", ")})`, expect: 1 };
      }
      return { sql: `DELETE FROM ${table} WHERE ${pairs.map(([c, v]) => `${access.quote(c.name)} = ${literal(v, c, access)}`).join(" AND ")}`, expect: 1 };
    });
  }

  const methods: Record<string, (cid: string, p: Params) => Promise<unknown>> = {
    async load(cid, p) {
      const file = str(p, "file");
      const config = await readConfig(folders.require(cid), file);
      return { file, config, problems: validateAggregate(config) };
    },
    async save(cid, p) {
      const file = str(p, "file");
      const config = normalizeAggregate(p.config);
      const problems = validateAggregate(config);
      if (problems.length) throw new EditError(problems.join("\n"));
      await writeConfig(folders.require(cid), file, config);
      return { file, config, problems };
    },
    async suggest(cid, p) {
      return suggest(cid, str(p, "database"), tableOf(p));
    },
    page: (cid, p) => page(cid, p),
    /** The columns of a table that reference a parent table, each with the parent's naming column. */
    async parents(cid, p) {
      const database = str(p, "database");
      const table = tableOf(p);
      const fks = (await foreignKeysOf(cid, database)).filter((f) => sameTable(f.table, table) && f.columns.length === 1);
      const columns = new Map<string, TableColumn[]>();
      for (const fk of fks) {
        try {
          columns.set(`${fk.refTable.schema}.${fk.refTable.table}`, await columnsOf(cid, { database, ...fk.refTable }));
        } catch {
          /* parent not visible */
        }
      }
      return parentLinks(table, fks, (t) => columns.get(`${t.schema}.${t.table}`) ?? []);
    },
    /** Parent rows to pick from (typed search), or the one row a foreign key value points at (to show its name). */
    async options(cid, p) {
      const database = str(p, "database");
      const refTable = tableOf(p);
      const column = str(p, "column");
      const target: TableTarget = { database, ...refTable };
      const columns = await columnsOf(cid, target);
      const link = { column: "", refTable, refColumn: column, display: typeof p.display === "string" && p.display ? p.display : null };
      const where = parentFilter(link, columns, access, { ...(typeof p.value === "string" || typeof p.value === "number" ? { value: String(p.value) } : {}), ...(typeof p.search === "string" ? { search: p.search } : {}) });
      const limit = Math.min(50, Math.max(1, Math.floor(Number(p.limit) || 20)));
      const keyIndex = columns.findIndex((c) => c.name === column);
      const labelIndex = link.display ? columns.findIndex((c) => c.name === link.display) : -1;
      if (keyIndex < 0) throw new EditError(`Unknown column "${column}".`);
      const order = [{ column: labelIndex >= 0 ? columns[labelIndex]!.name : column, desc: false }];
      const rows = await access.fetchPage(cid, target, columns, { limit: limit + 1, offset: 0, orderBy: order, where });
      const options: ParentOption[] = rows.slice(0, limit).map((r) => {
        const value = String(r[keyIndex] ?? "");
        return { value, label: optionLabel(labelIndex >= 0 ? r[labelIndex] : null, value) };
      });
      return { options, hasMore: rows.length > limit };
    },
    /**
     * Creates a parent row from the picker's "New …" dialog and answers the option to select. If the user gave the key it is
     * used as is; if the database chose it (identity), the row is found again by the values just inserted, newest first.
     */
    async createRow(cid, p) {
      const database = str(p, "database");
      const refTable = tableOf(p);
      const column = str(p, "column");
      const target: TableTarget = { database, ...refTable };
      const columns = await columnsOf(cid, target);
      const values = (p.values ?? {}) as Record<string, string | number | boolean | null>;
      const statements = buildStatements(target, columns, [{ kind: "insert", values }], access);
      await access.apply(cid, target, statements);

      const keyColumn = columns.find((c) => c.name === column);
      if (!keyColumn) throw new EditError(`Unknown column "${column}".`);
      const display = typeof p.display === "string" && p.display ? p.display : null;
      const given = values[column];
      const where = given !== undefined && given !== null && given !== "" ? `${access.quote(column)} = ${literal(given, keyColumn, access)}` : justInsertedFilter(values, columns, access);
      const rows = await access.fetchPage(cid, target, columns, { limit: 1, offset: 0, orderBy: [{ column, desc: true }], where });
      const row = rows[0];
      if (!row) return { option: null };
      const value = String(row[columns.findIndex((c) => c.name === column)] ?? "");
      return { option: { value, label: optionLabel(display ? row[columns.findIndex((c) => c.name === display)] : null, value) } satisfies ParentOption };
    },
    counts: (cid, p) => counts(cid, p),
    /** What deleting this row with its related rows would remove (nothing is deleted). */
    deletePlan: (cid, p) => deletePlan(cid, p, false),
    /** Deletes the row and its related rows in one transaction. */
    deleteTree: (cid, p) => deletePlan(cid, p, true),
    async link(cid, p) {
      const statements = await joinStatements(cid, p, "link");
      await access.apply(cid, { database: str(p, "database"), ...(p.relation as Relation).via!.table }, statements);
      return { linked: statements.length };
    },
    async unlink(cid, p) {
      const statements = await joinStatements(cid, p, "unlink");
      await access.apply(cid, { database: str(p, "database"), ...(p.relation as Relation).via!.table }, statements);
      return { unlinked: statements.length };
    },
  };

  return {
    async nodes(folder) {
      const entries = await list(folder);
      if (entries.length === 0) {
        return [{ id: "fa:empty", label: "No fast aggregates yet — right-click a table → New Fast Aggregate…", nodeType: `${prefix}.fastAggregateHint`, collapsible: "none", contextValue: `${prefix}.fastAggregatesRoot` }];
      }
      return entries.map((e): TreeNode => ({
        ...tab(e.file, e.config.name),
        tooltip: `${e.config.database}.${e.config.root.table.schema}.${e.config.root.table.table}\n${e.file}`,
        contextValue: `${prefix}.fastAggregate`,
        data: { aggregateFile: e.file },
      }));
    },

    command: {
      commandId: `${prefix}.aggregate`,
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

    tab,

    async create(connectionId, root) {
      const folder = folders.require(connectionId);
      const config = await suggest(connectionId, root.database, { schema: root.schema, table: root.table });
      const file = freeName(folder, "", config.name, AGGREGATE_EXT, "aggregate");
      await writeConfig(folder, file, config);
      return { file, name: config.name };
    },

    async rename(connectionId, file, name) {
      const folder = folders.require(connectionId);
      if (!name.trim()) throw new EditError("Give the aggregate a name.");
      const config = await readConfig(folder, file);
      await writeConfig(folder, file, { ...config, name: name.trim() });
    },

    async remove(connectionId, file) {
      await rm(inFolder(folders.require(connectionId), file));
    },
  };
}
