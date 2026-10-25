import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CellInput, Change, CutValue, LoadedTable, TableColumn } from "../src/table-editor/types.js";
import { invoke } from "./api.js";
import type { SqlDialectUi } from "./dialect.js";

/**
 * Table data editor (Edit Data on a table). Pages of rows come from the server; edits, new rows and deletes are only
 * staged here — keyed by primary key, so they survive paging, sorting and filtering — until "Review & Apply" shows the
 * SQL and runs it in one transaction. Rows are memoized and windowed, so a page of 1,000 rows stays smooth.
 */

const params = new URLSearchParams(globalThis.location?.search ?? "");
const target = { database: params.get("database") ?? "", schema: params.get("schema") ?? "", table: params.get("table") ?? "" };

const ROW_HEIGHT = 24;
const OVERSCAN = 10;
const PAGE_SIZES = [100, 200, 500, 1000];

type Answer<T> = { ok: true; data: T } | { ok: false; error: string };
type Staged = Map<string, { key: Record<string, CellInput>; set: Map<string, string | null> }>;
interface NewRow {
  id: number;
  values: Record<string, string | null>;
}
const isCut = (v: unknown): v is CutValue => typeof v === "object" && v !== null && (v as CutValue).cut === true;

function show(v: unknown, col: TableColumn): { text: string; tone: "" | "null" | "cut" } {
  if (v === null || v === undefined) return { text: "NULL", tone: "null" };
  if (isCut(v)) return { text: `${v.preview.replace(/\s+/g, " ")}… (${(v.size / 1024).toFixed(0)} KB — too large to edit here)`, tone: "cut" };
  if (typeof v === "boolean") return { text: v ? "true" : "false", tone: "" };
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return { text: col.kind === "json" || s.length > 300 ? s.slice(0, 300).replace(/\s+/g, " ") : s, tone: "" };
}

const widthOf = (c: TableColumn) => (c.kind === "bool" ? 84 : c.kind === "number" ? 120 : c.kind === "date" ? 180 : c.kind === "json" ? 240 : c.kind === "binary" ? 130 : 210);

export function TableEditor({ dialect }: { dialect: SqlDialectUi }) {
  const call = useCallback(
    async <T,>(method: string, extra: Record<string, unknown> = {}): Promise<T> => {
      const r = await invoke<Answer<T>>(`${dialect.prefix}.tableData`, { method, params: { ...target, ...extra } });
      if (!r.ok) throw new Error(r.error);
      return r.data;
    },
    [dialect.prefix],
  );

  const [loaded, setLoaded] = useState<LoadedTable | null>(null);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(200);
  const [orderBy, setOrderBy] = useState<Array<{ column: string; desc: boolean }>>([]);
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [edits, setEdits] = useState<Staged>(new Map());
  const [deletes, setDeletes] = useState<Map<string, Record<string, CellInput>>>(new Map());
  const [adds, setAdds] = useState<NewRow[]>([]);
  const [active, setActive] = useState<{ row: number; col: number; fresh?: number } | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: number; fresh?: number } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  const [review, setReview] = useState<{ script: string; statements: number; rows: number; error?: string; applying?: boolean } | null>(null);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Guards against an older page answering after a newer one was asked for. */
  const ticket = useRef(0);

  const columns = loaded?.columns ?? [];
  const pk = useMemo(() => columns.filter((c) => c.isPk), [columns]);
  const readOnly = !loaded || loaded.readOnlyReason !== null;
  const changeCount = adds.length + deletes.size + [...edits.values()].reduce((n, e) => n + (e.set.size ? 1 : 0), 0);

  const keyOf = useCallback((row: unknown[]) => JSON.stringify(pk.map((c) => row[columns.indexOf(c)])), [pk, columns]);
  const keyValues = useCallback((row: unknown[]): Record<string, CellInput> => Object.fromEntries(pk.map((c) => [c.name, row[columns.indexOf(c)] as CellInput])), [pk, columns]);

  async function fetchPage(over: { offset?: number; limit?: number; orderBy?: typeof orderBy; where?: string; first?: boolean } = {}) {
    const mine = ++ticket.current;
    setBusy(true);
    setError(null);
    const q = { offset: over.offset ?? offset, limit: over.limit ?? limit, orderBy: over.orderBy ?? orderBy, where: over.where ?? applied };
    try {
      if (over.first) {
        const l = await call<LoadedTable>("load", q);
        if (mine !== ticket.current) return;
        setLoaded(l);
        setRows(l.rows);
      } else {
        const p = await call<{ rows: unknown[][] }>("page", q);
        if (mine !== ticket.current) return;
        setRows(p.rows);
      }
      setOffset(q.offset);
      setSelected(new Set());
      setActive(null);
      setEditing(null);
      scrollRef.current?.scrollTo({ top: 0 });
    } catch (err) {
      if (mine === ticket.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === ticket.current) setBusy(false);
    }
  }

  useEffect(() => {
    void fetchPage({ first: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => window.oneclientView.setDirty(changeCount > 0), [changeCount]);

  // Viewport height for the windowing.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loaded]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- staging ----
  const stageEdit = useCallback(
    (rowIndex: number, col: number, value: string | null) => {
      const row = rows[rowIndex];
      if (!row) return;
      const c = columns[col]!;
      const k = keyOf(row);
      const original = row[col];
      const same = value === null ? original === null || original === undefined : original !== null && original !== undefined && String(original) === value;
      setEdits((prev) => {
        const next = new Map(prev);
        const entry = next.get(k) ?? { key: keyValues(row), set: new Map<string, string | null>() };
        const set = new Map(entry.set);
        if (same) set.delete(c.name);
        else set.set(c.name, value);
        if (set.size) next.set(k, { ...entry, set });
        else next.delete(k);
        return next;
      });
    },
    [rows, columns, keyOf, keyValues],
  );

  const stageNew = useCallback((id: number, col: number, value: string | null | undefined) => {
    const name = columns[col]!.name;
    setAdds((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const values = { ...r.values };
        if (value === undefined) delete values[name];
        else values[name] = value;
        return { ...r, values };
      }),
    );
  }, [columns]);

  function toggleDelete(indexes: number[]) {
    if (readOnly) return;
    setDeletes((prev) => {
      const next = new Map(prev);
      const allDeleted = indexes.every((i) => rows[i] && next.has(keyOf(rows[i]!)));
      for (const i of indexes) {
        const row = rows[i];
        if (!row) continue;
        if (allDeleted) next.delete(keyOf(row));
        else next.set(keyOf(row), keyValues(row));
      }
      return next;
    });
  }

  function addRow() {
    if (readOnly) return;
    setAdds((prev) => [...prev, { id: nextId.current++, values: {} }]);
    scrollRef.current?.scrollTo({ top: 0 });
  }

  function revertAll() {
    setEdits(new Map());
    setDeletes(new Map());
    setAdds([]);
    setEditing(null);
  }

  const changes = useCallback((): Change[] => {
    const out: Change[] = [];
    for (const e of edits.values()) if (e.set.size && !deletes.has(JSON.stringify(pk.map((c) => e.key[c.name])))) out.push({ kind: "update", key: e.key, set: Object.fromEntries(e.set) });
    for (const a of adds) out.push({ kind: "insert", values: a.values });
    for (const key of deletes.values()) out.push({ kind: "delete", key });
    return out;
  }, [edits, adds, deletes, pk]);

  async function openReview() {
    if (!changeCount) return;
    setReview({ script: "", statements: 0, rows: 0 });
    try {
      const r = await call<{ script: string; statements: number; rows: number }>("review", { changes: changes() });
      setReview(r);
    } catch (err) {
      setReview({ script: "", statements: 0, rows: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function apply() {
    if (!review) return;
    setReview({ ...review, applying: true });
    try {
      const r = await call<{ statements: number; rows: number }>("apply", { changes: changes() });
      revertAll();
      setReview(null);
      setNotice(`Saved: ${r.rows.toLocaleString()} row(s) in ${r.statements} statement(s).`);
      await fetchPage({ first: true });
    } catch (err) {
      setReview({ ...review, applying: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- paging, sorting, filtering ----
  const known = loaded?.estimatedRows ?? null;
  const exactTotal = rows.length < limit ? offset + rows.length : null;
  const hasNext = rows.length === limit && (exactTotal === null);
  const shown = rows.length ? `${(offset + 1).toLocaleString()}–${(offset + rows.length).toLocaleString()}` : "0";
  const totalText = exactTotal !== null ? exactTotal.toLocaleString() : applied ? "more" : known !== null ? `~${known.toLocaleString()}` : "more";

  function sortBy(name: string, additive: boolean) {
    const cur = orderBy.find((o) => o.column === name);
    let next = additive ? orderBy.filter((o) => o.column !== name) : [];
    if (!cur) next = [...next, { column: name, desc: false }];
    else if (!cur.desc) next = [...next, { column: name, desc: true }];
    setOrderBy(next);
    void fetchPage({ offset: 0, orderBy: next });
  }

  function applyFilter() {
    setApplied(filter.trim());
    void fetchPage({ offset: 0, where: filter.trim() });
  }

  // ---- keyboard ----
  function move(dr: number, dc: number) {
    if (!active || !columns.length) return;
    const total = adds.length + rows.length;
    const flat = active.fresh !== undefined ? adds.findIndex((a) => a.id === active.fresh) : adds.length + active.row;
    const nextFlat = Math.min(total - 1, Math.max(0, flat + dr));
    const col = Math.min(columns.length - 1, Math.max(0, active.col + dc));
    setActive(nextFlat < adds.length ? { row: -1, col, fresh: adds[nextFlat]!.id } : { row: nextFlat - adds.length, col });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0, e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0);
    } else if ((e.key === "Enter" || e.key === "F2") && active && !readOnly) {
      e.preventDefault();
      beginEdit(active);
    } else if (e.key === "Delete" && !readOnly) {
      e.preventDefault();
      if (active?.fresh !== undefined) setAdds((p) => p.filter((a) => a.id !== active.fresh));
      else toggleDelete(selected.size ? [...selected] : active ? [active.row] : []);
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void openReview();
    } else if (e.key === "Escape") {
      setSelected(new Set());
    } else if (mod && e.key === "0" && active && !readOnly) {
      e.preventDefault();
      setNull(active);
    }
  }

  function canEdit(at: { row: number; col: number; fresh?: number }): boolean {
    if (readOnly) return false;
    const c = columns[at.col];
    if (!c) return false;
    if (at.fresh !== undefined) return c.insertable;
    const v = rows[at.row]?.[at.col];
    return c.editable && !isCut(v) && !deletes.has(keyOf(rows[at.row]!));
  }
  function beginEdit(at: { row: number; col: number; fresh?: number }) {
    if (canEdit(at)) setEditing(at);
  }
  function setNull(at: { row: number; col: number; fresh?: number }) {
    if (!canEdit(at)) return;
    if (at.fresh !== undefined) stageNew(at.fresh, at.col, null);
    else stageEdit(at.row, at.col, null);
  }
  function commit(at: { row: number; col: number; fresh?: number }, value: string | null) {
    setEditing(null);
    if (at.fresh !== undefined) stageNew(at.fresh, at.col, value);
    else stageEdit(at.row, at.col, value);
    scrollRef.current?.focus();
  }
  const cancelEdit = () => {
    setEditing(null);
    scrollRef.current?.focus();
  };

  // Stable callbacks for the memoized rows: they read the latest handlers through a ref, so a keystroke in one cell
  // doesn't give every visible row new props.
  const latest = useRef({ beginEdit, commit, cancelEdit });
  latest.current = { beginEdit, commit, cancelEdit };
  const rowEdit = useCallback((row: number, col: number) => latest.current.beginEdit({ row, col }), []);
  const rowCommit = useCallback((row: number, col: number, v: string | null) => latest.current.commit({ row, col }, v), []);
  const rowCancel = useCallback(() => latest.current.cancelEdit(), []);

  // ---- windowing: only the visible slice of the page renders ----
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN - adds.length);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const widths = useMemo(() => columns.map(widthOf), [columns]);
  const totalWidth = 44 + widths.reduce((a, b) => a + b, 0);

  const onRowClick = useCallback((i: number, col: number, shift: boolean, mod: boolean) => {
    setActive({ row: i, col });
    if (col < 0) {
      setSelected((prev) => {
        const next = new Set(mod ? prev : []);
        if (shift && prev.size) {
          const anchor = Math.min(...prev);
          for (let r = Math.min(anchor, i); r <= Math.max(anchor, i); r++) next.add(r);
        } else if (mod && prev.has(i)) next.delete(i);
        else next.add(i);
        return next;
      });
    }
  }, []);

  if (error && !loaded) return <div className="te-page"><div className="te-error">{error}</div></div>;

  return (
    <div className="te-page">
      <div className="toolbar">
        <strong className="te-title" title={`${target.database}.${target.schema}.${target.table}`}>
          {target.schema}.{target.table}
        </strong>
        <span className="toolbar-sep" />
        <button className="btn" disabled={busy} onClick={() => void fetchPage({ first: true })} title="Reload the current page (staged changes stay)">
          ↻ Refresh
        </button>
        <button className="btn" disabled={busy || offset === 0} onClick={() => void fetchPage({ offset: Math.max(0, offset - limit) })} title="Previous page">
          ◀
        </button>
        <span className="te-range">
          {shown} of {totalText}
        </span>
        <button className="btn" disabled={busy || !hasNext} onClick={() => void fetchPage({ offset: offset + limit })} title="Next page">
          ▶
        </button>
        <select className="db-select" value={limit} onChange={(e) => { setLimit(Number(e.target.value)); void fetchPage({ offset: 0, limit: Number(e.target.value) }); }} title="Rows per page">
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} rows
            </option>
          ))}
        </select>
        <input
          className="te-filter"
          placeholder="Filter rows: WHERE condition…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applyFilter()}
          spellCheck={false}
        />
        <span className="toolbar-sep" />
        <button className="btn" disabled={readOnly} onClick={addRow} title="Add a row (staged until applied)">
          + Row
        </button>
        <button className="btn" disabled={readOnly || (!selected.size && !active)} onClick={() => (active?.fresh !== undefined ? setAdds((p) => p.filter((a) => a.id !== active.fresh)) : toggleDelete(selected.size ? [...selected] : active ? [active.row] : []))} title="Delete the selected rows (Delete key) — staged until applied">
          − Delete
        </button>
        <button className="btn" disabled={readOnly || !active} onClick={() => active && setNull(active)} title="Set the cell to NULL (Ctrl+0)">
          NULL
        </button>
        <span className="spacer" />
        {notice && <span className="toolbar-notice ok">{notice}</span>}
        {changeCount > 0 && (
          <>
            <span className="te-count">
              {changeCount} change{changeCount === 1 ? "" : "s"}
            </span>
            <button className="btn" onClick={revertAll} title="Discard every staged change">
              Revert
            </button>
            <button className="btn btn-run" onClick={() => void openReview()} title="Show the SQL and apply it in one transaction (Ctrl+S)">
              Review &amp; Apply…
            </button>
          </>
        )}
      </div>
      {loaded?.readOnlyReason && <div className="te-banner">{loaded.readOnlyReason} Showing data read-only.</div>}
      {error && <div className="te-error">{error}</div>}
      <div className="te-grid" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ width: totalWidth, minHeight: "100%" }}>
          <div className="te-row te-head" style={{ width: totalWidth }}>
            <div className="te-cell te-gutter" />
            {columns.map((c, i) => {
              const o = orderBy.findIndex((x) => x.column === c.name);
              return (
                <div key={c.name} className={`te-cell te-hcell ${o >= 0 ? "sorted" : ""}`} style={{ width: widths[i] }} title={`${c.name} — ${c.type}${c.isPk ? " · primary key" : ""}${c.nullable ? "" : " · not null"}\nClick to sort (Shift+click adds a column)`} onClick={(e) => sortBy(c.name, e.shiftKey)}>
                  {c.isPk && <span className="te-key">⚷</span>}
                  {c.name}
                  <span className="te-type">{c.type}</span>
                  {o >= 0 && <span className="sqlg-arrow">{orderBy[o]!.desc ? "▼" : "▲"}</span>}
                </div>
              );
            })}
          </div>
          {adds.map((a) => (
            <NewRowView key={a.id} row={a} columns={columns} widths={widths} totalWidth={totalWidth} active={active?.fresh === a.id ? active.col : -1} editing={editing?.fresh === a.id ? editing.col : -1} onActive={(col) => setActive({ row: -1, col, fresh: a.id })} onEdit={(col) => beginEdit({ row: -1, col, fresh: a.id })} onCommit={(col, v) => commit({ row: -1, col, fresh: a.id }, v)} onCancel={() => (setEditing(null), scrollRef.current?.focus())} onRemove={() => setAdds((p) => p.filter((x) => x.id !== a.id))} />
          ))}
          <div style={{ height: start * ROW_HEIGHT }} />
          {rows.slice(start, end).map((row, j) => {
            const i = start + j;
            const k = pk.length ? keyOf(row) : String(i);
            return (
              <DataRow
                key={`${offset}:${i}`}
                index={i}
                row={row}
                columns={columns}
                widths={widths}
                totalWidth={totalWidth}
                edit={edits.get(k)?.set}
                deleted={deletes.has(k)}
                selected={selected.has(i)}
                activeCol={active?.fresh === undefined && active?.row === i ? active.col : -1}
                editingCol={editing?.fresh === undefined && editing?.row === i ? editing.col : -1}
                rowNumber={offset + i + 1}
                editable={!readOnly}
                onClick={onRowClick}
                onEdit={rowEdit}
                onCommit={rowCommit}
                onCancel={rowCancel}
              />
            );
          })}
          <div style={{ height: Math.max(0, rows.length - end) * ROW_HEIGHT }} />
          {!busy && !rows.length && !adds.length && <div className="te-empty">{offset > 0 ? "No more rows." : applied ? "No rows match the filter." : "The table is empty."}</div>}
        </div>
      </div>
      {busy && <div className="te-busy">Loading…</div>}
      {review && (
        <div className="sqlg-overlay" onKeyDown={(e) => e.key === "Escape" && !review.applying && setReview(null)}>
          <div className="sqlg-dialog te-review" role="dialog" aria-labelledby="te-review-title">
            <div className="sqlg-dialog-title" id="te-review-title">
              Review the SQL
            </div>
            {review.error ? (
              <div className="te-error">{review.error}</div>
            ) : (
              <div className="sqlg-dialog-note">
                {review.script ? `${review.statements} statement(s) affecting ${review.rows.toLocaleString()} row(s), run in one transaction — all or nothing.` : "Preparing…"}
              </div>
            )}
            {review.script && <pre className="te-script">{review.script.length > 200_000 ? `${review.script.slice(0, 200_000)}\n-- … (${(review.script.length / 1024).toFixed(0)} KB in total, shortened here)` : review.script}</pre>}
            <div className="sqlg-dialog-actions">
              <span className="sqlg-spacer" />
              <button className="sqlg-btn" disabled={review.applying} onClick={() => setReview(null)}>
                {review.error ? "Close" : "Cancel"}
              </button>
              <button className="sqlg-btn on" disabled={!review.script || review.applying} onClick={() => void apply()}>
                {review.applying ? "Applying…" : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
interface DataRowProps {
  index: number;
  row: unknown[];
  columns: TableColumn[];
  widths: number[];
  totalWidth: number;
  edit: Map<string, string | null> | undefined;
  deleted: boolean;
  selected: boolean;
  activeCol: number;
  editingCol: number;
  rowNumber: number;
  editable: boolean;
  onClick(row: number, col: number, shift: boolean, mod: boolean): void;
  onEdit(row: number, col: number): void;
  onCommit(row: number, col: number, value: string | null): void;
  onCancel(): void;
}

/** Memoized: typing in one cell, or staging one edit, re-renders only the rows whose own props changed. */
const DataRow = memo(function DataRow(p: DataRowProps) {
  return (
    <div className={`te-row ${p.deleted ? "deleted" : ""} ${p.selected ? "selected" : ""} ${p.index % 2 ? "odd" : ""}`} style={{ width: p.totalWidth, height: ROW_HEIGHT }}>
      <div className="te-cell te-gutter" onClick={(e) => p.onClick(p.index, -1, e.shiftKey, e.ctrlKey || e.metaKey)} title="Click to select the row (Shift / Ctrl for several)">
        {p.rowNumber}
      </div>
      {p.columns.map((c, i) => {
        const staged = p.edit?.has(c.name) ?? false;
        const value = staged ? p.edit!.get(c.name) : p.row[i];
        return (
          <Cell key={c.name} column={c} value={value} width={p.widths[i]!} changed={staged} active={p.activeCol === i} editing={p.editingCol === i} readOnly={!p.editable || !c.editable || isCut(p.row[i])} onClick={(e) => p.onClick(p.index, i, e.shiftKey, e.ctrlKey || e.metaKey)} onDoubleClick={() => p.onEdit(p.index, i)} onCommit={(v) => p.onCommit(p.index, i, v)} onCancel={p.onCancel} />
        );
      })}
    </div>
  );
});

function NewRowView(p: { row: NewRow; columns: TableColumn[]; widths: number[]; totalWidth: number; active: number; editing: number; onActive(col: number): void; onEdit(col: number): void; onCommit(col: number, v: string | null): void; onCancel(): void; onRemove(): void }) {
  return (
    <div className="te-row added" style={{ width: p.totalWidth, height: ROW_HEIGHT }}>
      <div className="te-cell te-gutter" title="New row — click × to drop it" onClick={p.onRemove}>
        ×
      </div>
      {p.columns.map((c, i) => {
        const has = c.name in p.row.values;
        return (
          <Cell key={c.name} column={c} value={has ? p.row.values[c.name] : undefined} width={p.widths[i]!} changed={has} placeholder={!c.insertable ? "(set by database)" : c.hasDefault ? "(default)" : c.nullable ? "(null)" : "(required)"} active={p.active === i} editing={p.editing === i} readOnly={!c.insertable} onClick={() => p.onActive(i)} onDoubleClick={() => p.onEdit(i)} onCommit={(v) => p.onCommit(i, v)} onCancel={p.onCancel} />
        );
      })}
    </div>
  );
}

function Cell(p: { column: TableColumn; value: unknown; width: number; changed: boolean; active: boolean; editing: boolean; readOnly: boolean; placeholder?: string; onClick(e: React.MouseEvent): void; onDoubleClick(): void; onCommit(v: string | null): void; onCancel(): void }) {
  const { text, tone } = p.value === undefined && p.placeholder ? { text: p.placeholder, tone: "cut" as const } : show(p.value, p.column);
  return (
    <div className={`te-cell ${p.column.kind === "number" ? "num" : ""} ${tone} ${p.changed ? "changed" : ""} ${p.active ? "active" : ""} ${p.readOnly ? "ro" : ""}`} style={{ width: p.width }} onClick={p.onClick} onDoubleClick={p.onDoubleClick} title={isCut(p.value) ? "Too large to edit here" : text}>
      {p.editing ? <CellInput column={p.column} initial={p.value} onCommit={p.onCommit} onCancel={p.onCancel} /> : text}
    </div>
  );
}

function CellInput({ column, initial, onCommit, onCancel }: { column: TableColumn; initial: unknown; onCommit(v: string | null): void; onCancel(): void }) {
  const ref = useRef<HTMLInputElement | HTMLSelectElement>(null);
  const done = useRef(false);
  const text = initial === null || initial === undefined ? "" : typeof initial === "object" ? JSON.stringify(initial) : String(initial);
  useEffect(() => {
    ref.current?.focus();
    if (ref.current instanceof HTMLInputElement) ref.current.select();
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onCommit(v);
  };
  if (column.kind === "bool") {
    return (
      <select ref={ref as React.RefObject<HTMLSelectElement>} className="te-input" defaultValue={initial === null || initial === undefined ? "" : String(initial)} onChange={(e) => finish(e.target.value === "" ? null : e.target.value)} onBlur={onCancel} onKeyDown={(e) => e.key === "Escape" && (done.current = true, onCancel())}>
        <option value="true">true</option>
        <option value="false">false</option>
        {column.nullable && <option value="">NULL</option>}
      </select>
    );
  }
  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      className="te-input"
      defaultValue={text}
      spellCheck={false}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          finish((e.target as HTMLInputElement).value);
        } else if (e.key === "Escape") {
          done.current = true;
          onCancel();
        }
        e.stopPropagation();
      }}
    />
  );
}

