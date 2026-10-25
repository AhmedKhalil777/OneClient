import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AggregateConfig, AggregatePage, ParentLink, ParentOption, Relation, TableRef } from "../src/aggregate/types.js";
import type { CellInput, Change, CutValue } from "../src/table-editor/types.js";
import { invoke } from "./api.js";
import { ChooseContext, ErrorBox, useAutofocus, useChoose, useChooser, useEscape, type Choose } from "./aggregate-kit.js";
import type { SqlDialectUi } from "./dialect.js";
import { fromInputValue, htmlInput, inputKindOf, toInputValue } from "./inputs.js";

/**
 * Fast Aggregate: a table and what hangs off it as one editable thing. A paged list of the root's rows; a row opens into
 * a form with its children underneath (one-to-many as lists you can add to and edit, many-to-many as links you can add
 * and remove), and each child opens the same way — so a whole Order, its Items and their notes are reachable from one
 * screen. Reads go through `<prefix>.aggregate`; edits through the table editor's `<prefix>.tableData` (one
 * transaction per save, row-count checked).
 */

const params = new URLSearchParams(globalThis.location?.search ?? "");
const file = params.get("file") ?? "";

type Col = AggregatePage["columns"][number];
type Answer<T> = { ok: true; data: T } | { ok: false; error: string };
type Values = Record<string, unknown>;

/** Where an entity's rows come from: the root table, or a relation of an opened parent row. */
interface Entity {
  label: string;
  table: TableRef;
  listColumns?: string[] | undefined;
  children: Relation[];
  relation?: Relation;
  parentValues?: Values;
}

interface Frame {
  entity: Entity;
  columns: Col[];
  row: unknown[];
  /** The relation tab that was open, kept when you navigate into a child and back. */
  tab?: string;
}

const isCut = (v: unknown): v is CutValue => typeof v === "object" && v !== null && (v as CutValue).cut === true;
const record = (columns: Col[], row: unknown[]): Values => Object.fromEntries(columns.map((c, i) => [c.name, row[i]]));
const same = (a: TableRef, b: TableRef) => a.schema === b.schema && a.table === b.table;

function show(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (isCut(v)) return `${v.preview.replace(/\s+/g, " ")}…`;
  if (typeof v === "boolean") return v ? "✓" : "✗";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 80 ? `${s.slice(0, 80).replace(/\s+/g, " ")}…` : s;
}

const TITLE_COLUMNS = ["name", "title", "number", "code", "label", "email", "description"];

/** "Order #12" / "Order · Spring sale": a row's name in the breadcrumb. */
function titleOf(label: string, columns: Col[], row: unknown[]): string {
  const values = record(columns, row);
  const named = TITLE_COLUMNS.map((n) => columns.find((c) => c.name.toLowerCase() === n)).find((c) => c && values[c.name] !== null && values[c.name] !== undefined);
  const key = columns.filter((c) => c.isPk).map((c) => String(values[c.name] ?? "")).join(", ");
  if (named) return `${label} · ${show(values[named.name])}`;
  return key ? `${label} #${key}` : label;
}

function visibleColumns(columns: Col[], wanted: string[] | undefined): Col[] {
  if (wanted?.length) {
    const picked = wanted.map((n) => columns.find((c) => c.name === n)).filter((c): c is Col => !!c);
    if (picked.length) return picked;
  }
  // Plain text columns count: PostgreSQL flags text / varchar as "large", but they are the columns people recognise a row by.
  // Binary is never shown; JSON only when nothing else is there.
  const usable = columns.filter((c) => c.kind !== "binary");
  const plain = usable.filter((c) => c.kind !== "json");
  return (plain.length ? plain : usable).slice(0, 7);
}

export function Aggregate({ dialect }: { dialect: SqlDialectUi }) {
  const api = useMemo(() => {
    const call = async <T,>(command: string, method: string, p: Record<string, unknown>): Promise<T> => {
      const r = await invoke<Answer<T>>(`${dialect.prefix}.${command}`, { method, params: p });
      if (!r.ok) throw new Error(r.error);
      return r.data;
    };
    return {
      aggregate: <T,>(method: string, p: Record<string, unknown> = {}) => call<T>("aggregate", method, p),
      data: <T,>(method: string, p: Record<string, unknown>) => call<T>("tableData", method, p),
    };
  }, [dialect.prefix]);

  const [config, setConfig] = useState<AggregateConfig | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stack, setStack] = useState<Frame[]>([]);
  const [configuring, setConfiguring] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialogs, choose] = useChooser();
  // The row form tells us when it has unsaved edits (and how to save them), so leaving it can ask first.
  const guard = useRef<{ dirty: boolean; save: (() => Promise<boolean>) | null }>({ dirty: false, save: null });
  const reportDirty = useCallback((dirty: boolean, save: (() => Promise<boolean>) | null) => {
    guard.current = { dirty, save };
    try {
      window.oneclientView?.setDirty(dirty);
    } catch {
      /* not inside a view host */
    }
  }, []);

  useEffect(() => {
    api
      .aggregate<{ config: AggregateConfig; problems: string[] }>("load", { file })
      .then((r) => (setConfig(r.config), setProblems(r.problems)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api]);

  const say = useCallback((m: string) => {
    setNotice(m);
    setTimeout(() => setNotice((n) => (n === m ? null : n)), 4000);
  }, []);

  if (error) return <div className="agg-page"><div className="agg-error">{error}</div></div>;
  if (!config) return <div className="agg-page"><div className="agg-empty">Loading…</div></div>;

  const rootEntity: Entity = { label: config.root.label || config.name, table: config.root.table, listColumns: config.root.columns, children: config.root.children };
  const top = stack[stack.length - 1];

  /** Runs `action` — after asking what to do with unsaved edits, if there are any. */
  async function go(action: () => void): Promise<void> {
    const g = guard.current;
    if (!g.dirty) return action();
    const pick = await choose({
      title: "You have unsaved changes",
      message: "Save them before you leave, or they are lost.",
      choices: [
        { id: "save", label: "Save", primary: true },
        { id: "discard", label: "Discard", danger: true },
        { id: "stay", label: "Keep editing" },
      ],
    });
    if (pick === "save") {
      if (g.save && !(await g.save())) return;
      reportDirty(false, null);
      action();
    } else if (pick === "discard") {
      reportDirty(false, null);
      action();
    }
  }

  const crumbs: Array<{ label: string; go: () => void }> = [{ label: config.name, go: () => void go(() => setStack([])) }];
  stack.forEach((f, i) => {
    if (f.entity.relation) crumbs.push({ label: f.entity.relation.label, go: () => void go(() => setStack(stack.slice(0, i))) });
    crumbs.push({ label: titleOf(f.entity.label, f.columns, f.row), go: () => void go(() => setStack(stack.slice(0, i + 1))) });
  });

  const open = (entity: Entity, columns: Col[], row: unknown[]) => setStack((s) => [...s, { entity, columns, row }]);
  const setTab = (i: number, tab: string) => setStack((s) => s.map((f, k) => (k === i ? { ...f, tab } : f)));

  return (
    <ChooseContext.Provider value={choose}>
    <div className="agg-page">
      <div className="agg-bar">
        <div className="agg-crumbs">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="agg-sep">›</span>}
              <button className={`agg-crumb${i === crumbs.length - 1 ? " last" : ""}`} onClick={c.go}>
                {c.label}
              </button>
            </span>
          ))}
        </div>
        <span className="agg-spacer" />
        {notice && <span className="agg-notice">{notice}</span>}
        <button className="agg-btn" onClick={() => void go(() => setConfiguring(!configuring))}>
          {configuring ? "Close configuration" : "Configure"}
        </button>
      </div>
      {problems.length > 0 && <div className="agg-error">{problems.join("\n")}</div>}

      {configuring ? (
        <Configure
          config={config}
          database={config.database}
          api={api}
          onSaved={(c, p) => {
            setConfig(c);
            setProblems(p);
            setStack([]);
            setConfiguring(false);
            say("Configuration saved.");
          }}
        />
      ) : !top ? (
        <EntityList key="root" api={api} database={config.database} entity={rootEntity} onOpen={open} onNotice={say} />
      ) : (
        <RowView
          key={stack.map((f) => titleOf(f.entity.label, f.columns, f.row)).join("/")}
          api={api}
          database={config.database}
          frame={top}
          onTab={(tab) => setTab(stack.length - 1, tab)}
          onOpen={(e, c, r) => void go(() => open(e, c, r))}
          onDirty={reportDirty}
          onChanged={(row) => setStack((s) => s.map((f, k) => (k === s.length - 1 ? { ...f, row } : f)))}
          onDeleted={() => (setStack((s) => s.slice(0, -1)), say("Deleted."))}
          onNotice={say}
        />
      )}
      {dialogs}
    </div>
    </ChooseContext.Provider>
  );
}

type Api = {
  aggregate<T>(method: string, p?: Record<string, unknown>): Promise<T>;
  data<T>(method: string, p: Record<string, unknown>): Promise<T>;
};

/**
 * Deletes a row, asking first. If it has related rows in the configuration, says how many and offers to delete them with
 * it (children before parents, in one transaction) instead of failing on the database's foreign key.
 * Resolves true when the row is gone.
 */
async function deleteRow(api: Api, database: string, entity: Entity, columns: Col[], row: unknown[], choose: Choose): Promise<boolean> {
  const values = record(columns, row);
  const label = entity.label.toLowerCase();
  const key = Object.fromEntries(columns.filter((c) => c.isPk).map((c) => [c.name, values[c.name] as CellInput]));
  const plain = () => api.data("apply", { database, ...entity.table, changes: [{ kind: "delete", key }] satisfies Change[] });
  let plan: { items: Array<{ label: string; count: number }>; total: number } = { items: [], total: 1 };
  if (entity.children.length) plan = await api.aggregate("deletePlan", { database, ...entity.table, values, relations: entity.children });

  if (plan.items.length === 0) {
    const pick = await choose({ title: `Delete this ${label}?`, message: titleOf(entity.label, columns, row), choices: [{ id: "delete", label: "Delete", primary: true, danger: true }, { id: "cancel", label: "Cancel" }] });
    if (pick !== "delete") return false;
    await plain();
    return true;
  }
  const pick = await choose({
    title: `Delete this ${label} and its related rows?`,
    message: (
      <>
        <div>{titleOf(entity.label, columns, row)} is used by:</div>
        <ul className="agg-confirm-list">
          {plan.items.map((i) => (
            <li key={i.label}>
              <strong>{i.count}</strong> {i.label}
            </li>
          ))}
        </ul>
      </>
    ),
    choices: [
      { id: "tree", label: `Delete all (${plan.total} rows)`, primary: true, danger: true },
      { id: "only", label: `Only this ${label}` },
      { id: "cancel", label: "Cancel" },
    ],
  });
  if (pick === "tree") await api.aggregate("deleteTree", { database, ...entity.table, values, relations: entity.children });
  else if (pick === "only") await plain();
  else return false;
  return true;
}

// ------------------------------------------------------------------------------------------------ a list of rows

function EntityList({
  api,
  database,
  entity,
  onOpen,
  onNotice,
  onChanged,
}: {
  api: Api;
  database: string;
  entity: Entity;
  onOpen: (entity: Entity, columns: Col[], row: unknown[]) => void;
  onNotice: (m: string) => void;
  /** Rows were added, removed or linked (the parent's counts are stale). */
  onChanged?: () => void;
}) {
  const choose = useChoose();
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [selected, setSelected] = useState(0);
  const [data, setData] = useState<AggregatePage | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [version, setVersion] = useState(0);
  const many = entity.relation?.kind === "manyToMany";
  const parents = useParents(api, database, entity.table);
  const parentCtx: ParentCtx = { api, database, parents, onOpenParent: (link, value) => void openParent(api, database, onOpen)(link, value).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))) };

  // The search box applies itself shortly after you stop typing.
  useEffect(() => {
    const t = setTimeout(() => {
      setAppliedSearch((prev) => (prev === search ? prev : (setOffset(0), search)));
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const request = useMemo(
    () => ({
      database,
      ...entity.table,
      limit,
      offset,
      filter: applied,
      search: appliedSearch,
      ...(sort ? { orderBy: [sort] } : {}),
      ...(entity.relation ? { relation: entity.relation, parentValues: entity.parentValues ?? {} } : {}),
    }),
    [database, entity, limit, offset, applied, appliedSearch, sort],
  );

  useEffect(() => {
    let alive = true;
    setBusy(true);
    api
      .aggregate<AggregatePage>("page", request)
      .then((d) => alive && (setData(d), setError(null), setSelected(0)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [api, request, version]);

  // Foreign key columns show the parent's name (a product, a customer) instead of its bare key.
  const [labels, setLabels] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => {
    if (!data) return;
    const links = Object.values(parents).filter((l) => l.display);
    if (links.length === 0) return;
    let alive = true;
    Promise.all(
      links.map(async (link) => {
        const index = data.columns.findIndex((c) => c.name === link.column);
        const values = [...new Set(data.rows.map((r) => r[index]).filter((v) => v !== null && v !== undefined).map(String))];
        if (index < 0 || values.length === 0) return [link.column, {}] as const;
        const r = await api.aggregate<{ labels: Record<string, string> }>("labels", { database, ...link.refTable, column: link.refColumn, display: link.display, values });
        return [link.column, r.labels] as const;
      }),
    )
      .then((pairs) => alive && setLabels(Object.fromEntries(pairs)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, database, data, parents]);

  const refresh = () => setVersion((v) => v + 1);
  const changed = () => (refresh(), onChanged?.());
  const cols = data ? visibleColumns(data.columns, entity.relation?.columns ?? entity.listColumns) : [];
  const filtered = Boolean(applied || appliedSearch);
  const canDelete = Boolean(data && (!data.readOnlyReason || many));

  async function remove(row: unknown[]) {
    if (!data) return;
    const values = record(data.columns, row);
    try {
      if (many) {
        const pick = await choose({ title: "Remove this link?", message: `The ${entity.label.toLowerCase()} itself is kept — only its link to this row goes.`, choices: [{ id: "unlink", label: "Unlink", primary: true, danger: true }, { id: "cancel", label: "Cancel" }] });
        if (pick !== "unlink") return;
        await api.aggregate("unlink", { database, relation: entity.relation, parentValues: entity.parentValues ?? {}, children: [values] });
        onNotice("Unlinked.");
      } else {
        if (!(await deleteRow(api, database, entity, data.columns, row, choose))) return;
        onNotice("Deleted.");
      }
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!data || data.rows.length === 0) return;
    if (e.key === "ArrowDown") (e.preventDefault(), setSelected((i) => Math.min(data.rows.length - 1, i + 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setSelected((i) => Math.max(0, i - 1)));
    else if (e.key === "Enter") (e.preventDefault(), onOpen(entity, data.columns, data.rows[selected]!));
    else if (e.key === "Delete" && canDelete) (e.preventDefault(), void remove(data.rows[selected]!));
    else if (e.key === "PageDown" && data.hasMore) (e.preventDefault(), setOffset(offset + limit));
    else if (e.key === "PageUp" && offset > 0) (e.preventDefault(), setOffset(Math.max(0, offset - limit)));
  }

  const toggleSort = (name: string) =>
    setSort((s) => (s?.column !== name ? { column: name, desc: false } : !s.desc ? { column: name, desc: true } : null));

  const addButton =
    data && !data.readOnlyReason && !many ? (
      <button className="agg-btn primary" onClick={() => setCreating(true)}>
        ＋ New {entity.label.toLowerCase()}
      </button>
    ) : many ? (
      <button className="agg-btn primary" onClick={() => setLinking(true)}>
        ＋ Link existing…
      </button>
    ) : null;

  return (
    <div className="agg-body">
      <div className="agg-toolbar">
        <strong>{entity.relation ? entity.relation.label : entity.label}</strong>
        <input className="agg-search" type="search" placeholder="Search…" value={search} spellCheck={false} onChange={(e) => setSearch(e.target.value)} />
        <button className={`agg-btn${advanced ? " on" : ""}`} title="Filter with a SQL condition" onClick={() => setAdvanced(!advanced)}>
          Advanced
        </button>
        <button className="agg-btn" title="Reload" onClick={refresh}>
          ⟳
        </button>
        <span className="agg-spacer" />
        {addButton}
      </div>
      {advanced && (
        <div className="agg-toolbar agg-advanced">
          <input
            className="agg-filter"
            placeholder="A SQL condition, e.g. status = 'open' AND total > 100"
            value={filter}
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (setOffset(0), setApplied(filter))}
          />
          <button className="agg-btn" onClick={() => (setOffset(0), setApplied(filter))}>
            Apply
          </button>
          {applied && (
            <button className="agg-btn" onClick={() => (setFilter(""), setApplied(""), setOffset(0))}>
              Clear
            </button>
          )}
        </div>
      )}
      {data?.readOnlyReason && <div className="agg-banner">{data.readOnlyReason}</div>}
      {error && <ErrorBox message={error} />}
      <div className="agg-gridwrap" tabIndex={0} onKeyDown={onKeyDown} aria-label={`${entity.label} list`}>
        <table className="agg-grid">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.name} title={`${c.type} — click to sort`} className={`${sort?.column === c.name ? "sorted" : ""}${c.kind === "number" ? " num" : ""}`} onClick={() => toggleSort(c.name)}>
                  {c.name}
                  {sort?.column === c.name && <span className="agg-sortmark">{sort.desc ? "▼" : "▲"}</span>}
                </th>
              ))}
              <th className="agg-actions-col" />
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((row, i) => (
              <tr key={i} className={i === selected ? "sel" : ""} onClick={() => (setSelected(i), onOpen(entity, data.columns, row))} title="Open">
                {cols.map((c) => {
                  const v = row[data.columns.indexOf(c)];
                  const parentName = v === null || v === undefined ? undefined : labels[c.name]?.[String(v)];
                  return (
                    <td key={c.name} className={v === null || v === undefined ? "null" : parentName ? "" : c.kind === "number" ? "num" : ""} title={parentName ? `${parentName} (#${String(v)})` : undefined}>
                      {parentName ? (
                        <>
                          {parentName} <span className="agg-dim">#{String(v)}</span>
                        </>
                      ) : (
                        show(v)
                      )}
                    </td>
                  );
                })}
                <td className="agg-actions-col">
                  {canDelete ? (
                    <button
                      className="agg-icon danger"
                      title={many ? "Unlink" : "Delete"}
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(row);
                      }}
                    >
                      {many ? "⊘" : "🗑"}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {data && data.rows.length === 0 && (
              <tr className="agg-emptyrow">
                <td colSpan={cols.length + 1} className="agg-empty">
                  {filtered ? (
                    <>
                      Nothing matches.{" "}
                      <button className="agg-link" onClick={() => (setSearch(""), setAppliedSearch(""), setFilter(""), setApplied(""), setOffset(0))}>
                        Clear the search
                      </button>
                    </>
                  ) : (
                    <>
                      <div>No {(entity.relation?.label ?? entity.label).toLowerCase()} yet.</div>
                      {addButton && <div className="agg-empty-action">{addButton}</div>}
                    </>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="agg-pager">
        <button className="agg-btn" disabled={offset === 0 || busy} onClick={() => setOffset(Math.max(0, offset - limit))}>
          ◀ Previous
        </button>
        <span className="agg-dim">
          {data && data.rows.length > 0 ? `Rows ${offset + 1}–${offset + data.rows.length}` : "No rows"}
          {busy ? " · loading…" : ""}
        </span>
        <button className="agg-btn" disabled={!data?.hasMore || busy} onClick={() => setOffset(offset + limit)}>
          Next ▶
        </button>
        <span className="agg-spacer" />
        <span className="agg-dim agg-hint">↑↓ select · Enter open · Del {many ? "unlink" : "delete"}</span>
        <label className="agg-dim">
          Rows per page{" "}
          <select value={limit} onChange={(e) => (setLimit(Number(e.target.value)), setOffset(0))}>
            {[10, 25, 50, 100].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>

      {creating && data && (
        <RowDialog
          title={`New ${entity.label.toLowerCase()}`}
          columns={data.columns}
          inherited={inheritedOf(entity)}
          parents={parentCtx}
          onCancel={() => setCreating(false)}
          onSave={async (values) => {
            await api.data("apply", { database, ...entity.table, changes: [{ kind: "insert", values }] satisfies Change[] });
            setCreating(false);
            onNotice("Created.");
            changed();
          }}
        />
      )}
      {linking && entity.relation && (
        <LinkDialog
          api={api}
          database={database}
          entity={entity}
          onClose={() => setLinking(false)}
          onLinked={(n) => {
            setLinking(false);
            onNotice(`Linked ${n}.`);
            changed();
          }}
        />
      )}
    </div>
  );
}

/** The foreign key values a new child row gets from its parent. */
function inheritedOf(entity: Entity): Record<string, CellInput> {
  const out: Record<string, CellInput> = {};
  if (entity.relation?.kind !== "oneToMany") return out;
  for (const l of entity.relation.link) {
    const v = entity.parentValues?.[l.parentColumn];
    if (v !== null && v !== undefined) out[l.column] = typeof v === "number" || typeof v === "boolean" ? v : String(v);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ one row + its children

function RowView({
  api,
  database,
  frame,
  onTab,
  onOpen,
  onChanged,
  onDeleted,
  onNotice,
  onDirty,
}: {
  api: Api;
  database: string;
  frame: Frame;
  onTab: (tab: string) => void;
  onOpen: (entity: Entity, columns: Col[], row: unknown[]) => void;
  onChanged: (row: unknown[]) => void;
  onDeleted: () => void;
  onNotice: (m: string) => void;
  onDirty: (dirty: boolean, save: (() => Promise<boolean>) | null) => void;
}) {
  const { entity, columns, row } = frame;
  const choose = useChoose();
  // Stable between renders: the form resets itself whenever these values change, so a new object each render would wipe what you typed.
  const values = useMemo(() => record(columns, row), [columns, row]);
  const children = entity.children;
  const active = children.find((c) => c.id === frame.tab) ?? children[0];
  const readOnly = !columns.some((c) => c.isPk);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, { n: number; more: boolean }>>({});
  const [countsVersion, setCountsVersion] = useState(0);
  const parents = useParents(api, database, entity.table);
  const parentCtx: ParentCtx = { api, database, parents, onOpenParent: (link, value) => void openParent(api, database, onOpen)(link, value).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))) };
  const rowKey = JSON.stringify(row);
  const [formWidth, setFormWidth] = useState(() => {
    try {
      const n = Number(localStorage.getItem("oneclient.aggregate.formWidth"));
      return Number.isFinite(n) && n >= 260 ? n : 400;
    } catch {
      return 400;
    }
  });

  /** Drag the divider between the form and the related tables; the width is remembered. */
  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const split = e.currentTarget.parentElement!;
    const left = split.getBoundingClientRect().left;
    const max = () => Math.max(300, split.clientWidth - 320);
    let latest = formWidth;
    const move = (ev: PointerEvent) => {
      latest = Math.round(Math.min(max(), Math.max(260, ev.clientX - left)));
      setFormWidth(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging-col");
      try {
        localStorage.setItem("oneclient.aggregate.formWidth", String(latest));
      } catch {
        /* not remembered */
      }
    };
    document.body.classList.add("dragging-col");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // "Items (12)": how many related rows each tab holds.
  useEffect(() => {
    if (children.length === 0) return;
    let alive = true;
    api
      .aggregate<Record<string, { n: number; more: boolean }>>("counts", { database, parentValues: values, relations: children })
      .then((c) => alive && setCounts(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, database, rowKey, countsVersion]);

  async function save(set: Record<string, CellInput>) {
    const key = Object.fromEntries(columns.filter((c) => c.isPk).map((c) => [c.name, values[c.name] as CellInput]));
    await api.data("apply", { database, ...entity.table, changes: [{ kind: "update", key, set }] satisfies Change[] });
    // Re-read the row so the form shows what the database now holds (defaults, triggers, normalised values).
    const fresh = await api.aggregate<AggregatePage>("page", {
      database,
      ...entity.table,
      limit: 1,
      filter: "",
      ...(entity.relation ? { relation: entity.relation, parentValues: entity.parentValues ?? {} } : {}),
      // Just this row, by its (possibly just changed) key.
      key: { ...values, ...set },
    });
    if (fresh.rows[0]) onChanged(fresh.rows[0]);
    onNotice("Saved.");
  }

  async function remove() {
    try {
      if (await deleteRow(api, database, entity, columns, row, choose)) onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="agg-body">
      <div className="agg-toolbar">
        <strong>{titleOf(entity.label, columns, row)}</strong>
        <span className="agg-dim">
          {entity.table.schema}.{entity.table.table}
        </span>
        <span className="agg-spacer" />
        {!readOnly && (
          <button className="agg-btn danger" onClick={() => void remove()}>
            🗑 Delete
          </button>
        )}
      </div>
      {error && <ErrorBox message={error} />}
      <div className="agg-split" style={{ gridTemplateColumns: `${formWidth}px 6px minmax(0, 1fr)` }}>
        <div className="agg-form">
          {readOnly && <div className="agg-banner">This table has no primary key, so this row can't be edited.</div>}
          <RowForm columns={columns} values={values} readOnly={readOnly} onSave={save} parents={parentCtx} onDirty={onDirty} />
        </div>
        <div className="agg-splitter" role="separator" aria-orientation="vertical" title="Drag to resize" onPointerDown={startResize} onDoubleClick={() => setFormWidth(400)} />
        <div className="agg-children">
          {children.length === 0 ? (
            <div className="agg-empty">This {entity.label.toLowerCase()} has no related tables in the configuration.</div>
          ) : (
            <>
              <div className="agg-tabs" role="tablist">
                {children.map((c) => (
                  <button key={c.id} role="tab" aria-selected={c.id === active?.id} className={`agg-tab${c.id === active?.id ? " on" : ""}`} onClick={() => onTab(c.id)}>
                    {c.label}
                    {counts[c.id] && (
                      <span className="agg-count" title={counts[c.id]!.more ? "100 or more" : `${counts[c.id]!.n} related`}>
                        {counts[c.id]!.n}
                        {counts[c.id]!.more ? "+" : ""}
                      </span>
                    )}
                    <span className="agg-kind">{c.kind === "manyToMany" ? "N:N" : "1:N"}</span>
                  </button>
                ))}
              </div>
              {active && (
                <EntityList
                  key={`${active.id}`}
                  api={api}
                  database={database}
                  entity={{ label: active.label.replace(/s$/, ""), table: active.table, listColumns: active.columns, children: active.children, relation: active, parentValues: values }}
                  onOpen={onOpen}
                  onNotice={onNotice}
                  onChanged={() => setCountsVersion((v) => v + 1)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ parents (many-to-one)

type Parents = Record<string, ParentLink>;

/** What a form needs to offer parent rows for foreign key columns, and to open the chosen parent. */
interface ParentCtx {
  api: Api;
  database: string;
  parents: Parents;
  onOpenParent: (link: ParentLink, value: string) => void;
}

/** The columns of `table` that point at a parent table, by column name (empty while loading or when there are none). */
function useParents(api: Api, database: string, table: TableRef): Parents {
  const [parents, setParents] = useState<Parents>({});
  useEffect(() => {
    let alive = true;
    api
      .aggregate<ParentLink[]>("parents", { database, ...table })
      .then((list) => alive && setParents(Object.fromEntries(list.map((l) => [l.column, l]))))
      .catch(() => alive && setParents({}));
    return () => {
      alive = false;
    };
  }, [api, database, table.schema, table.table]);
  return parents;
}

/**
 * A row's own columns as one compact JSON object — what the picker shows under the chosen parent, so you can tell which
 * row "1 (#1)" is. Binary values and huge text are left out or cut; the whole thing is shortened for the line.
 */
function summarize(columns: Col[], row: unknown[]): { line: string; full: string } {
  const obj: Record<string, unknown> = {};
  columns.forEach((c, i) => {
    const v = row[i];
    if (c.kind === "binary") return;
    obj[c.name] = isCut(v) ? `${v.preview.slice(0, 60)}…` : typeof v === "string" && v.length > 80 ? `${v.slice(0, 80)}…` : v;
  });
  const line = JSON.stringify(obj);
  return { line: line.length > 240 ? `${line.slice(0, 240)}…` : line, full: JSON.stringify(obj, null, 2) };
}

const titleCase = (name: string) => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
};

/** Opens the parent row a foreign key points at, as an entity of its own (its form, without children). */
function openParent(api: Api, database: string, onOpen: (entity: Entity, columns: Col[], row: unknown[]) => void) {
  return async (link: ParentLink, value: string) => {
    const key = { [link.refColumn]: value };
    const page = await api.aggregate<AggregatePage>("page", { database, ...link.refTable, limit: 1, filter: "", key });
    if (page.rows[0]) onOpen({ label: titleCase(link.refTable.table).replace(/s$/, ""), table: link.refTable, children: [] }, page.columns, page.rows[0]);
  };
}

/**
 * A foreign key column: search the parent's rows by name (or key) and pick one, instead of typing a key that may not
 * exist. Shows the chosen parent's name; ↗ opens it. Falls back to a plain input if the parent can't be searched.
 */
function LookupInput({ ctx, link, field, disabled, onChange }: { ctx: ParentCtx; link: ParentLink; field: Field; disabled: boolean; onChange: (f: Field) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<ParentOption[] | null>(null);
  const [more, setMore] = useState(false);
  const [label, setLabel] = useState("");
  const [broken, setBroken] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ line: string; full: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const base = { database: ctx.database, ...link.refTable, column: link.refColumn, ...(link.display ? { display: link.display } : {}) };

  // The name of the parent the current value points at.
  useEffect(() => {
    if (field.isNull || !field.text) return setLabel("");
    let alive = true;
    ctx.api
      .aggregate<{ options: ParentOption[] }>("options", { ...base, value: field.text, limit: 1 })
      .then((r) => alive && setLabel(r.options[0]?.label ?? `${field.text} — not found in ${link.refTable.table}`))
      .catch((e: unknown) => alive && setBroken(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.text, field.isNull]);

  // The chosen parent's own columns, as a line under the field.
  useEffect(() => {
    if (field.isNull || !field.text) return setSummary(null);
    let alive = true;
    ctx.api
      .aggregate<AggregatePage>("page", { database: ctx.database, ...link.refTable, limit: 1, filter: "", by: { column: link.refColumn, value: field.text } })
      .then((p) => alive && setSummary(p.rows[0] ? summarize(p.columns, p.rows[0]) : null))
      .catch(() => alive && setSummary(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.text, field.isNull]);

  // Matches while the list is open.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const t = setTimeout(() => {
      ctx.api
        .aggregate<{ options: ParentOption[]; hasMore: boolean }>("options", { ...base, search, limit: 20 })
        .then((r) => alive && (setOptions(r.options), setMore(r.hasMore)))
        .catch((e: unknown) => alive && setBroken(e instanceof Error ? e.message : String(e)));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, search]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  if (broken) {
    return <input value={field.text} disabled={disabled} title={`Can't search ${link.refTable.table}: ${broken}`} spellCheck={false} onChange={(e) => onChange({ text: e.target.value, isNull: false, touched: true })} />;
  }

  return (
    <div className="agg-lookup" ref={box}>
      <input
        value={open ? search : field.isNull ? "" : label || field.text}
        disabled={disabled}
        spellCheck={false}
        placeholder={field.isNull ? "NULL" : `Search ${link.refTable.table}…`}
        title={`References ${link.refTable.schema}.${link.refTable.table}.${link.refColumn}`}
        onFocus={() => (setSearch(""), setOpen(true))}
        onChange={(e) => setSearch(e.target.value)}
      />
      {!disabled && !field.isNull && field.text && (
        <button type="button" className="agg-null" title={`Open this ${titleCase(link.refTable.table).toLowerCase()}`} onClick={() => ctx.onOpenParent(link, field.text)}>
          ↗
        </button>
      )}
      {summary && !open && (
        <div className="agg-summary" title={summary.full}>
          <span className="agg-summary-table">{link.refTable.table}</span> {summary.line}
        </div>
      )}
      {creating !== null && (
        <CreateParentDialog
          ctx={ctx}
          link={link}
          search={creating}
          onCancel={() => setCreating(null)}
          onCreated={(o) => {
            onChange({ text: o.value, isNull: false, touched: true });
            setLabel(o.label);
            setCreating(null);
          }}
        />
      )}
      {open && !disabled && (
        <div className="agg-lookup-list">
          <div className="agg-lookup-item agg-lookup-new" onMouseDown={(e) => (e.preventDefault(), setCreating(search), setOpen(false))}>
            ＋ New {titleCase(link.refTable.table).replace(/s$/, "").toLowerCase()}…
          </div>
          {options === null && <div className="agg-lookup-item agg-dim">Searching…</div>}
          {options?.map((o) => (
            <div key={o.value} className={`agg-lookup-item${o.value === field.text ? " on" : ""}`} onMouseDown={(e) => (e.preventDefault(), onChange({ text: o.value, isNull: false, touched: true }), setLabel(o.label), setOpen(false))}>
              {o.label}
            </div>
          ))}
          {options && options.length === 0 && <div className="agg-lookup-item agg-dim">No {link.refTable.table} match “{search}”.</div>}
          {more && <div className="agg-lookup-item agg-dim">…type to narrow the list</div>}
        </div>
      )}
    </div>
  );
}

/**
 * The picker's "New …": the parent table's own create dialog, stacked on top of the one you are in. Its own foreign keys
 * get pickers too (an order's customer can be created with its country picked), and saving selects the new row.
 */
function CreateParentDialog({ ctx, link, search, onCancel, onCreated }: { ctx: ParentCtx; link: ParentLink; search: string; onCancel: () => void; onCreated: (o: ParentOption) => void }) {
  const [columns, setColumns] = useState<Col[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parents = useParents(ctx.api, ctx.database, link.refTable);
  useEscape(error ? onCancel : null);

  useEffect(() => {
    ctx.api
      .aggregate<AggregatePage>("page", { database: ctx.database, ...link.refTable, limit: 1, filter: "" })
      .then((p) => setColumns(p.columns))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [ctx.api, ctx.database, link.refTable.schema, link.refTable.table]);

  if (error) {
    return (
      <div className="agg-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
        <div className="agg-dialog">
          <h3>New {link.refTable.table}</h3>
          <ErrorBox message={error} />
          <div className="agg-formbar">
            <button className="agg-btn" onClick={onCancel}>Close</button>
          </div>
        </div>
      </div>
    );
  }
  if (!columns) return null;

  return (
    <RowDialog
      title={`New ${titleCase(link.refTable.table).replace(/s$/, "").toLowerCase()}`}
      columns={columns}
      inherited={{}}
      // What was typed in the picker becomes the new row's name.
      initial={link.display && search.trim() ? { [link.display]: search.trim() } : {}}
      parents={{ ...ctx, parents }}
      onCancel={onCancel}
      onSave={async (values) => {
        const r = await ctx.api.aggregate<{ option: ParentOption | null }>("createRow", { database: ctx.database, ...link.refTable, column: link.refColumn, ...(link.display ? { display: link.display } : {}), values });
        if (!r.option) throw new Error("The row was created, but it could not be found again to select it — search for it in the list.");
        onCreated(r.option);
      }}
    />
  );
}

// ------------------------------------------------------------------------------------------------ forms

interface Field {
  text: string;
  isNull: boolean;
  touched: boolean;
}

function fieldOf(v: unknown): Field {
  if (v === null || v === undefined) return { text: "", isNull: true, touched: false };
  if (isCut(v)) return { text: v.preview, isNull: false, touched: false };
  return { text: typeof v === "object" ? JSON.stringify(v, null, 2) : String(v), isNull: false, touched: false };
}

function Input({ col, field, disabled, onChange, parent }: { col: Col; field: Field; disabled: boolean; onChange: (f: Field) => void; parent?: { ctx: ParentCtx; link: ParentLink } | undefined }) {
  const set = (text: string) => onChange({ text, isNull: false, touched: true });
  const kind = inputKindOf(col);
  if (parent) return <LookupInput ctx={parent.ctx} link={parent.link} field={field} disabled={disabled} onChange={onChange} />;
  if (kind.kind === "bool") {
    return (
      <select value={field.isNull ? "" : field.text} disabled={disabled} onChange={(e) => onChange({ text: e.target.value, isNull: e.target.value === "", touched: true })}>
        <option value="">{col.nullable ? "NULL" : "—"}</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (kind.kind === "json" || kind.kind === "multiline" || field.text.length > 120 || field.text.includes(String.fromCharCode(10))) {
    return <textarea rows={3} value={field.text} disabled={disabled} spellCheck={false} onChange={(e) => set(e.target.value)} />;
  }
  const html = htmlInput(kind);
  const typed = kind.kind === "date" || kind.kind === "time" || kind.kind === "datetime";
  // A picker shows the value in its own format; an unreadable value shows empty, but stays as is until the user picks one.
  const shown = typed ? toInputValue(kind, field.text) : field.text;
  return (
    <input
      type={html.type}
      {...(html.step ? { step: html.step } : {})}
      value={shown}
      disabled={disabled}
      spellCheck={false}
      placeholder={field.isNull ? "NULL" : col.hasDefault ? "(default)" : ""}
      onChange={(e) => set(typed ? fromInputValue(kind, e.target.value) : e.target.value)}
    />
  );
}

function RowForm({
  columns,
  values,
  readOnly,
  onSave,
  parents,
  onDirty,
}: {
  columns: Col[];
  values: Values;
  readOnly: boolean;
  onSave: (set: Record<string, CellInput>) => Promise<void>;
  parents: ParentCtx;
  /** Tells the screen whether there are unsaved edits, and how to save them. */
  onDirty: (dirty: boolean, save: (() => Promise<boolean>) | null) => void;
}) {
  const initial = useMemo(() => Object.fromEntries(columns.map((c) => [c.name, fieldOf(values[c.name])])), [columns, values]);
  const [fields, setFields] = useState<Record<string, Field>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setFields(initial), [initial]);

  const changed = columns.filter((c) => c.editable && fields[c.name]?.touched);
  async function submit(): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const set: Record<string, CellInput> = {};
      for (const c of changed) set[c.name] = fields[c.name]!.isNull ? null : fields[c.name]!.text;
      await onSave(set);
      setSaved(true);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const submitRef = useRef(submit);
  submitRef.current = submit;
  const dirty = changed.length > 0;
  useEffect(() => {
    onDirty(dirty, dirty ? () => submitRef.current() : null);
    if (dirty) setSaved(false);
  }, [dirty]);
  useEffect(() => () => onDirty(false, null), []);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(t);
  }, [saved]);

  return (
    <div
      className="agg-formwrap"
      onKeyDown={(e) => {
        // Ctrl+S saves from anywhere in the form.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          if (dirty && !busy && !readOnly) void submit();
        }
      }}
    >
      <div className="agg-fields">
        {columns.map((c) => {
          const f = fields[c.name]!;
          const locked = readOnly || !c.editable || isCut(values[c.name]);
          return (
            <label key={c.name} className={`agg-field${f.touched ? " changed" : ""}`}>
              <span className="agg-label">
                {c.isPk && <span title="Primary key">🔑 </span>}
                {c.name} <span className="agg-dim">{c.type}{!c.nullable && !c.hasDefault && !c.isPk ? " · required" : ""}</span>
              </span>
              <span className="agg-input">
                <Input col={c} field={f} disabled={locked} parent={parents.parents[c.name] ? { ctx: parents, link: parents.parents[c.name]! } : undefined} onChange={(next) => setFields({ ...fields, [c.name]: next })} />
                {c.nullable && !locked && c.kind !== "bool" && (
                  <button type="button" className={`agg-null${f.isNull ? " on" : ""}`} title="Set to NULL" onClick={() => setFields({ ...fields, [c.name]: { text: "", isNull: !f.isNull, touched: true } })}>
                    NULL
                  </button>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {error && <ErrorBox message={error} />}
      {!readOnly && (
        <div className="agg-formbar sticky">
          <button className="agg-btn primary" disabled={busy || !dirty} title="Ctrl+S" onClick={() => void submit()}>
            Save{changed.length ? ` (${changed.length})` : ""}
          </button>
          <button className="agg-btn" disabled={busy || !dirty} onClick={() => (setFields(initial), setError(null))}>
            Revert
          </button>
          {dirty && <span className="agg-dim">Unsaved changes</span>}
          {saved && !dirty && <span className="agg-saved">Saved ✓</span>}
        </div>
      )}
    </div>
  );
}

function RowDialog({
  title,
  columns,
  inherited,
  initial,
  parents,
  onSave,
  onCancel,
}: {
  title: string;
  columns: Col[];
  inherited: Record<string, CellInput>;
  /** Values to start the form with (editable, unlike `inherited`). */
  initial?: Record<string, string>;
  parents: ParentCtx;
  onSave: (values: Record<string, CellInput>) => Promise<void>;
  onCancel: () => void;
}) {
  const insertable = columns.filter((c) => c.insertable);
  const [fields, setFields] = useState<Record<string, Field>>(() => Object.fromEntries(insertable.map((c) => [c.name, { text: inherited[c.name] !== undefined ? String(inherited[c.name]) : (initial?.[c.name] ?? ""), isNull: false, touched: inherited[c.name] !== undefined || initial?.[c.name] !== undefined }])));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useAutofocus(dialog);
  useEscape(onCancel);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const values: Record<string, CellInput> = {};
      for (const c of insertable) {
        const f = fields[c.name]!;
        const typed = f.text !== "" || f.isNull;
        // A column the database fills in (identity, default) stays out of the INSERT unless the user typed something.
        if (!typed && (c.hasDefault || c.nullable)) continue;
        values[c.name] = f.isNull ? null : f.text;
      }
      await onSave(values);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="agg-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="agg-dialog"
        ref={dialog}
        role="dialog"
        aria-label={title}
        onKeyDown={(e) => {
          // Enter in a one-line field creates; Ctrl+Enter creates from anywhere.
          if (e.key === "Enter" && !busy && (e.ctrlKey || e.metaKey || (e.target as HTMLElement).tagName === "INPUT")) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <h3>{title}</h3>
        <div className="agg-fields">
          {insertable.map((c) => (
            <label key={c.name} className="agg-field">
              <span className="agg-label">
                {c.name} <span className="agg-dim">{c.type}{c.hasDefault ? " · default" : ""}{!c.nullable && !c.hasDefault ? " · required" : ""}</span>
              </span>
              <span className="agg-input">
                <Input col={c} field={fields[c.name]!} disabled={inherited[c.name] !== undefined} parent={parents.parents[c.name] ? { ctx: parents, link: parents.parents[c.name]! } : undefined} onChange={(next) => setFields({ ...fields, [c.name]: next })} />
              </span>
            </label>
          ))}
        </div>
        {error && <ErrorBox message={error} />}
        <div className="agg-formbar">
          <button className="agg-btn primary" disabled={busy} onClick={() => void submit()}>
            Create
          </button>
          <button className="agg-btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ many-to-many: link existing

function LinkDialog({ api, database, entity, onClose, onLinked }: { api: Api; database: string; entity: Entity; onClose: () => void; onLinked: (n: number) => void }) {
  const relation = entity.relation!;
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [data, setData] = useState<AggregatePage | null>(null);
  const [picked, setPicked] = useState<Map<number, Values>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const limit = 10;
  useEscape(onClose);

  useEffect(() => {
    api
      .aggregate<AggregatePage>("page", { database, ...relation.table, limit, offset, filter: applied, relation, parentValues: entity.parentValues ?? {}, candidates: true })
      .then((d) => (setData(d), setError(null)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, database, relation, entity.parentValues, offset, applied]);

  const cols = data ? visibleColumns(data.columns, relation.columns) : [];
  async function link() {
    if (!data) return;
    setBusy(true);
    try {
      const children = [...picked.values()];
      await api.aggregate("link", { database, relation, parentValues: entity.parentValues ?? {}, children });
      onLinked(children.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="agg-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="agg-dialog wide">
        <h3>Link existing {relation.label.toLowerCase()}</h3>
        <div className="agg-toolbar">
          <input className="agg-filter" placeholder="Filter — a SQL condition" value={filter} spellCheck={false} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (setOffset(0), setApplied(filter))} />
          <button className="agg-btn" onClick={() => (setOffset(0), setApplied(filter))}>
            Filter
          </button>
        </div>
        {error && <div className="agg-error">{error}</div>}
        <div className="agg-gridwrap short">
          <table className="agg-grid">
            <thead>
              <tr>
                <th />
                {cols.map((c) => (
                  <th key={c.name}>{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((row, i) => {
                const key = offset + i;
                return (
                  <tr key={key} onClick={() => setPicked((m) => { const n = new Map(m); if (n.has(key)) n.delete(key); else n.set(key, record(data.columns, row)); return n; })}>
                    <td>
                      <input type="checkbox" readOnly checked={picked.has(key)} />
                    </td>
                    {cols.map((c) => (
                      <td key={c.name}>{show(row[data.columns.indexOf(c)])}</td>
                    ))}
                  </tr>
                );
              })}
              {data && data.rows.length === 0 && (
                <tr>
                  <td colSpan={cols.length + 1} className="agg-empty">
                    Nothing left to link.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="agg-pager">
          <button className="agg-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
            ◀
          </button>
          <button className="agg-btn" disabled={!data?.hasMore} onClick={() => setOffset(offset + limit)}>
            ▶
          </button>
          <span className="agg-spacer" />
          <button className="agg-btn primary" disabled={busy || picked.size === 0} onClick={() => void link()}>
            Link {picked.size || ""}
          </button>
          <button className="agg-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ configuration

function Configure({ config, database, api, onSaved }: { config: AggregateConfig; database: string; api: Api; onSaved: (c: AggregateConfig, problems: string[]) => void }) {
  const [draft, setDraft] = useState<AggregateConfig>(config);
  const [json, setJson] = useState(() => JSON.stringify(config, null, 2));
  const [mode, setMode] = useState<"outline" | "json">("outline");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const choose = useChoose();

  const update = (next: AggregateConfig) => {
    setDraft(next);
    setJson(JSON.stringify(next, null, 2));
  };

  /** Applies `fn` to the relation list owned by the node at `path` (indexes from the root; [] = the root's own list). */
  function mutate(path: number[], fn: (list: Relation[]) => Relation[]): void {
    const clone = structuredClone(draftRef.current);
    let node: { children: Relation[] } = clone.root;
    for (const i of path) node = node.children[i]!;
    node.children = fn(node.children);
    update(clone);
  }

  async function save(c: AggregateConfig) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.aggregate<{ config: AggregateConfig; problems: string[] }>("save", { file, config: c });
      onSaved(r.config, r.problems);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function resuggest() {
    const pick = await choose({ title: "Re-suggest the relations?", message: "The relations are replaced by a fresh suggestion from the database's foreign keys. Your renames and removals are lost.", choices: [{ id: "yes", label: "Replace", primary: true, danger: true }, { id: "no", label: "Keep mine" }] });
    if (pick !== "yes") return;
    setBusy(true);
    try {
      const fresh = await api.aggregate<AggregateConfig>("suggest", { database, ...draft.root.table });
      update({ ...draft, root: { ...draft.root, children: fresh.root.children } });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const renderList = (list: Relation[], path: number[], depth: number) =>
    list.map((r, i) => (
      <div key={r.id}>
        <div className="agg-rel" style={{ paddingLeft: 8 + depth * 18 }}>
          <span className="agg-kind">{r.kind === "manyToMany" ? "N:N" : "1:N"}</span>
          <input value={r.label} onChange={(e) => mutate(path, (l) => l.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} />
          <span className="agg-dim">
            {r.table.table}
            {r.via ? ` via ${r.via.table.table}` : ` (${r.link.map((l) => `${l.column}→${l.parentColumn}`).join(", ")})`}
          </span>
          <input
            className="agg-cols"
            placeholder="columns shown (comma separated; blank = first few)"
            defaultValue={(r.columns ?? []).join(", ")}
            spellCheck={false}
            onBlur={(e) => mutate(path, (l) => l.map((x, k) => (k === i ? { ...x, ...(e.target.value.trim() ? { columns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : { columns: undefined }) } : x)))}
          />
          <button className="agg-icon danger" title="Remove this relation" onClick={() => mutate(path, (l) => l.filter((_, k) => k !== i))}>
            ✕
          </button>
        </div>
        {renderList(r.children, [...path, i], depth + 1)}
      </div>
    ));

  return (
    <div className="agg-body">
      <div className="agg-toolbar">
        <strong>Configure</strong>
        <button className={`agg-btn${mode === "outline" ? " primary" : ""}`} onClick={() => setMode("outline")}>
          Relations
        </button>
        <button className={`agg-btn${mode === "json" ? " primary" : ""}`} onClick={() => setMode("json")}>
          JSON
        </button>
        <span className="agg-spacer" />
        <button className="agg-btn" disabled={busy} onClick={() => void resuggest()}>
          Re-suggest from foreign keys
        </button>
        <button
          className="agg-btn primary"
          disabled={busy}
          onClick={() => {
            try {
              void save(mode === "json" ? (JSON.parse(json) as AggregateConfig) : draft);
            } catch (e) {
              setError(`The JSON is not valid: ${e instanceof Error ? e.message : String(e)}`);
            }
          }}
        >
          Save
        </button>
      </div>
      {error && <div className="agg-error">{error}</div>}
      {mode === "outline" ? (
        <div className="agg-outline">
          <div className="agg-fields">
            <label className="agg-field">
              <span className="agg-label">Name</span>
              <input value={draft.name} onChange={(e) => update({ ...draft, name: e.target.value })} />
            </label>
            <label className="agg-field">
              <span className="agg-label">Root table</span>
              <input value={`${draft.database} · ${draft.root.table.schema}.${draft.root.table.table}`} disabled />
            </label>
            <label className="agg-field">
              <span className="agg-label">Root columns shown</span>
              <input
                placeholder="comma separated; blank = first few"
                defaultValue={(draft.root.columns ?? []).join(", ")}
                spellCheck={false}
                onBlur={(e) => update({ ...draft, root: { ...draft.root, ...(e.target.value.trim() ? { columns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : { columns: undefined }) } })}
              />
            </label>
          </div>
          <div className="agg-label" style={{ padding: "8px 12px 2px" }}>
            Relations — remove what you don't need, rename the rest
          </div>
          {draft.root.children.length === 0 ? <div className="agg-empty">No related tables were found. Use “Re-suggest”, or add relations in the JSON.</div> : renderList(draft.root.children, [], 0)}
        </div>
      ) : (
        <textarea className="agg-json" value={json} spellCheck={false} onChange={(e) => setJson(e.target.value)} />
      )}
    </div>
  );
}
