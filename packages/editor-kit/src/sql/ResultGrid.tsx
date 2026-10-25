import { useEffect, useMemo, useRef, useState } from "react";
import { type Dialect, type Rect, type ResultSet, display, pick, prettyValue, toCsv, toInserts, toJson, toMarkdown, toTsv, viewOrder } from "./data.js";

const ROW_HEIGHT = 22;
const OVERSCAN = 8;

export interface ResultGridProps {
  result: ResultSet;
  /** Grow to fill the parent (one result set) instead of a fixed-height block (several). */
  fill: boolean;
  /** Identifier quoting and literals for "Copy as INSERT". */
  dialect: Dialect;
  /** Default table for INSERT exports and the base of saved file names. */
  tableHint?: string | undefined;
  /** Export ▾ and "Copy … as" CSV / TSV / JSON / Markdown / INSERT (default on; plain Ctrl+C always works). */
  exports?: boolean;
  /** The cell viewer: double-click / Enter opens a value in full, pretty-printed (default on). */
  cellViewer?: boolean;
}

type Format = "tsv" | "csv" | "json" | "markdown" | "insert";
const FORMATS: Array<{ id: Format; label: string; ext: string; mime: string }> = [
  { id: "csv", label: "CSV", ext: "csv", mime: "text/csv" },
  { id: "tsv", label: "TSV (Excel paste)", ext: "tsv", mime: "text/tab-separated-values" },
  { id: "json", label: "JSON", ext: "json", mime: "application/json" },
  { id: "markdown", label: "Markdown table", ext: "md", mime: "text/markdown" },
  { id: "insert", label: "SQL INSERT statements", ext: "sql", mime: "application/sql" },
];

type Menu = { x: number; y: number; kind: "context" | "export" } | null;

/**
 * Results grid shared by the SQL plugins. Click a header to sort (again for descending, a third time to clear); type in
 * the filter box (any column, or `column:value`); click, shift-click or drag to select a range; Ctrl+C copies it
 * (Ctrl+Shift+C with headers); double-click or Enter opens the cell viewer; right-click or Export copies / saves the
 * selection — or every shown row — as CSV, TSV, JSON, Markdown or INSERTs. Only visible rows render, so 10k rows stay smooth.
 */
export function ResultGrid({ result, fill, dialect, tableHint, exports = true, cellViewer = true }: ResultGridProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  const [sel, setSel] = useState<Rect | null>(null);
  const [widths, setWidths] = useState<number[]>(() => initialWidths(result));
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<Menu>(null);
  const [viewer, setViewer] = useState<{ row: number; col: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [table, setTable] = useState(tableHint || "table_name");
  const dragging = useRef(false);

  const { columns } = result;
  const order = useMemo(() => viewOrder(result, filter, sort), [result, filter, sort]);
  const count = order.length;
  const lastCol = columns.length - 1;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(count, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const rowNumWidth = useMemo(() => Math.max(36, String(result.rows.length).length * 8 + 16), [result.rows.length]);
  const totalWidth = rowNumWidth + widths.reduce((a, b) => a + b, 0);

  // A changed filter or sort reorders rows, so a selection would point at different data.
  useEffect(() => setSel(null), [filter, sort]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const norm = sel && { ra: Math.min(sel.r0, sel.r1), rb: Math.max(sel.r0, sel.r1), ca: Math.min(sel.c0, sel.c1), cb: Math.max(sel.c0, sel.c1) };
  const inSel = (r: number, c: number) => !!norm && r >= norm.ra && r <= norm.rb && c >= norm.ca && c <= norm.cb;
  const single = !!norm && norm.ra === norm.rb && norm.ca === norm.cb;

  /** The selection, or — with nothing (or one cell) selected, for exports — every shown row. */
  const scope = (wholeIfSingle: boolean) =>
    sel && !(wholeIfSingle && single) ? pick(result, order, sel) : pick(result, order, { r0: 0, c0: 0, r1: count - 1, c1: lastCol });

  const render = (f: Format, data: { columns: ResultSet["columns"]; rows: unknown[][] }) =>
    f === "csv" ? toCsv(data.columns, data.rows) : f === "tsv" ? toTsv(data.columns, data.rows) : f === "json" ? toJson(data.columns, data.rows) : f === "markdown" ? toMarkdown(data.columns, data.rows) : toInserts(data.columns, data.rows, table, dialect);

  function copy(text: string, what: string) {
    copyText(text);
    setToast(`Copied ${what}`);
    scrollRef.current?.focus();
  }
  const copySelection = (headers: boolean) => {
    if (!sel) return;
    const data = pick(result, order, sel);
    copy(single && !headers ? display(data.rows[0]?.[0]) : toTsv(headers ? data.columns : null, data.rows), single && !headers ? "cell" : `${data.rows.length.toLocaleString()} rows`);
  };
  const copyAs = (f: Format) => {
    const data = scope(menu?.kind === "export");
    copy(render(f, data), `${data.rows.length.toLocaleString()} rows as ${FORMATS.find((x) => x.id === f)!.label}`);
    setMenu(null);
  };
  const saveAs = (f: Format) => {
    const fmt = FORMATS.find((x) => x.id === f)!;
    const data = scope(true);
    download(`${(tableHint || "results").replace(/[^\w.-]+/g, "_")}.${fmt.ext}`, new Blob([render(f, data)], { type: `${fmt.mime};charset=utf-8` }));
    setToast(`Saved ${data.rows.length.toLocaleString()} rows`);
    setMenu(null);
  };

  function scrollIntoView(r: number) {
    const el = scrollRef.current;
    if (!el) return;
    const top = r * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT * 2; // + header
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && k.toLowerCase() === "a") {
      e.preventDefault();
      if (count) setSel({ r0: 0, c0: 0, r1: count - 1, c1: lastCol });
    } else if (mod && k.toLowerCase() === "c") {
      e.preventDefault();
      copySelection(e.shiftKey);
    } else if ((k === "Enter" || k === "F2") && sel && cellViewer) {
      e.preventDefault();
      setViewer({ row: sel.r1, col: sel.c1 });
    } else if (k === "Escape") {
      setSel(null);
    } else if (k.startsWith("Arrow") || k === "Home" || k === "End" || k === "PageUp" || k === "PageDown") {
      if (!count) return;
      e.preventDefault();
      const cur = sel ?? { r0: 0, c0: 0, r1: 0, c1: 0 };
      const page = Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1);
      let { r1, c1 } = cur;
      if (k === "ArrowDown") r1 = mod ? count - 1 : r1 + 1;
      if (k === "ArrowUp") r1 = mod ? 0 : r1 - 1;
      if (k === "ArrowRight") c1 = mod ? lastCol : c1 + 1;
      if (k === "ArrowLeft") c1 = mod ? 0 : c1 - 1;
      if (k === "PageDown") r1 += page;
      if (k === "PageUp") r1 -= page;
      if (k === "Home") [c1, r1] = [0, mod ? 0 : r1];
      if (k === "End") [c1, r1] = [lastCol, mod ? count - 1 : r1];
      r1 = clamp(r1, 0, count - 1);
      c1 = clamp(c1, 0, lastCol);
      setSel(e.shiftKey && sel ? { ...cur, r1, c1 } : { r0: r1, c0: c1, r1, c1 });
      scrollIntoView(r1);
    }
  }

  function cellDown(e: React.MouseEvent, r: number, c: number) {
    if (e.button !== 0) return;
    scrollRef.current?.focus();
    dragging.current = true;
    setSel((s) => (e.shiftKey && s ? { ...s, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c }));
  }
  function rowDown(e: React.MouseEvent, r: number) {
    if (e.button !== 0) return;
    scrollRef.current?.focus();
    setSel((s) => (e.shiftKey && s ? { ...s, c0: 0, r1: r, c1: lastCol } : { r0: r, c0: 0, r1: r, c1: lastCol }));
  }
  function onContextMenu(e: React.MouseEvent, r: number, c: number) {
    e.preventDefault();
    if (!inSel(r, c)) setSel({ r0: r, c0: c, r1: r, c1: c });
    setMenu({ x: e.clientX, y: e.clientY, kind: "context" });
  }

  function toggleSort(col: number) {
    setSort((s) => (s?.col !== col ? { col, desc: false } : !s.desc ? { col, desc: true } : null));
  }

  function startResize(col: number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = widths[col] ?? 100;
    const onMove = (ev: MouseEvent) => setWidths((w) => w.map((x, i) => (i === col ? Math.max(40, startWidth + ev.clientX - startX) : x)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const stats = useMemo(() => (sel && !single ? selectionStats(pick(result, order, sel).rows) : null), [sel, single, result, order]);
  const ctxValue = sel ? result.rows[order[sel.r1]!]?.[sel.c1] : undefined;

  return (
    <div className={`sqlg ${fill ? "fill" : ""}`}>
      <div className="sqlg-bar">
        <input
          className="sqlg-filter"
          placeholder="Filter rows…  (column:value for one column)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setFilter("")}
          spellCheck={false}
        />
        <span className="sqlg-count">
          {filter ? `${count.toLocaleString()} of ${result.rows.length.toLocaleString()}` : result.rows.length.toLocaleString()} rows
          {sort && ` · sorted by ${columns[sort.col]?.name} ${sort.desc ? "↓" : "↑"}`}
        </span>
        <span className="sqlg-spacer" />
        {stats && <span className="sqlg-stats">{stats}</span>}
        {toast && <span className="sqlg-toast">{toast}</span>}
        {exports && (
        <button
          className="sqlg-btn"
          title="Copy or save the selection (or all shown rows)"
          onClick={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            setMenu(menu?.kind === "export" ? null : { x: b.right, y: b.bottom + 2, kind: "export" });
          }}
        >
          Export ▾
        </button>
        )}
      </div>
      <div
        className="sqlg-scroll"
        ref={(el) => {
          scrollRef.current = el;
          if (el && el.clientHeight && el.clientHeight !== viewport) setViewport(el.clientHeight);
        }}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          setViewport(e.currentTarget.clientHeight);
        }}
        style={fill ? undefined : { height: Math.min(300, ROW_HEIGHT * (count + 1) + 18) }}
      >
        <div className="sqlg-grid" style={{ width: totalWidth }}>
          <div className="sqlg-header" style={{ height: ROW_HEIGHT }}>
            <div className="sqlg-cell sqlg-rownum sqlg-corner" style={{ width: rowNumWidth }} onClick={() => count && setSel({ r0: 0, c0: 0, r1: count - 1, c1: lastCol })} title="Select all (Ctrl+A)" />
            {columns.map((c, i) => (
              <div
                key={i}
                className={`sqlg-cell sqlg-head ${sort?.col === i ? "sorted" : ""}`}
                style={{ width: widths[i] }}
                title={`${c.name} (${c.type}) — click to sort, shift-click to select the column`}
                onClick={(e) => (e.shiftKey ? count && setSel({ r0: 0, c0: i, r1: count - 1, c1: i }) : toggleSort(i))}
              >
                <span className="sqlg-head-name">{c.name}</span>
                {sort?.col === i && <span className="sqlg-arrow">{sort.desc ? "▼" : "▲"}</span>}
                <span className="sqlg-resize" onMouseDown={(e) => startResize(i, e)} onClick={(e) => e.stopPropagation()} />
              </div>
            ))}
          </div>
          <div style={{ height: count * ROW_HEIGHT, position: "relative" }}>
            {order.slice(first, last).map((src, offset) => {
              const r = first + offset;
              const row = result.rows[src]!;
              const rowHit = !!norm && r >= norm.ra && r <= norm.rb;
              return (
                <div key={src} className="sqlg-row" style={{ top: r * ROW_HEIGHT, height: ROW_HEIGHT }}>
                  <div className={`sqlg-cell sqlg-rownum ${rowHit ? "hit" : ""}`} style={{ width: rowNumWidth }} onMouseDown={(e) => rowDown(e, r)}>
                    {src + 1}
                  </div>
                  {row.map((value, c) => (
                    <div
                      key={c}
                      className={`sqlg-cell ${value === null || value === undefined ? "null" : ""} ${typeof value === "number" || typeof value === "bigint" ? "num" : ""} ${inSel(r, c) ? "selected" : ""}`}
                      style={{ width: widths[c] }}
                      onMouseDown={(e) => cellDown(e, r, c)}
                      onMouseEnter={() => dragging.current && setSel((s) => (s ? { ...s, r1: r, c1: c } : s))}
                      onDoubleClick={() => cellViewer && setViewer({ row: r, col: c })}
                      onContextMenu={(e) => onContextMenu(e, r, c)}
                    >
                      {cellText(value)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        {count === 0 && <div className="sqlg-empty">{result.rows.length ? "No rows match the filter." : "The query returned no rows."}</div>}
      </div>
      {result.totalRows > result.rows.length && (
        <div className="sqlg-note">
          Showing the first {result.rows.length.toLocaleString()} of {result.totalRows.toLocaleString()} rows — sorting, filtering and exports cover those.
        </div>
      )}
      {menu && (
        <Popup x={menu.x} y={menu.y} alignRight={menu.kind === "export"} onClose={() => setMenu(null)}>
          {menu.kind === "context" && (
            <>
              <button onClick={() => (copySelection(false), setMenu(null))}>
                Copy <kbd>Ctrl+C</kbd>
              </button>
              <button onClick={() => (copySelection(true), setMenu(null))}>
                Copy with headers <kbd>Ctrl+Shift+C</kbd>
              </button>
              {sel && cellViewer && (
                <button onClick={() => (setViewer({ row: sel.r1, col: sel.c1 }), setMenu(null))}>
                  View value <kbd>Enter</kbd>
                </button>
              )}
              {sel && ctxValue !== undefined && (
                <button
                  onClick={() => {
                    setFilter(`${columns[sel.c1]!.name}:${display(ctxValue)}`);
                    setMenu(null);
                  }}
                >
                  Filter by this value
                </button>
              )}
              <hr />
            </>
          )}
          {exports && (
            <>
          <div className="sqlg-menu-head">Copy {menu.kind === "context" || (sel && !single) ? "selection" : "shown rows"} as</div>
          {FORMATS.map((f) => (
            <button key={f.id} onClick={() => copyAs(f.id)}>
              {f.label}
            </button>
          ))}
          <label className="sqlg-menu-table" title="Target table for INSERT statements">
            INSERT into <input value={table} onChange={(e) => setTable(e.target.value)} onKeyDown={(e) => e.stopPropagation()} spellCheck={false} />
          </label>
          {menu.kind === "export" && (
            <>
              <hr />
              <div className="sqlg-menu-head">Save {sel && !single ? "selection" : "shown rows"} to file</div>
              {FORMATS.filter((f) => f.id !== "tsv").map((f) => (
                <button key={f.id} onClick={() => saveAs(f.id)}>
                  {f.label} (.{f.ext})
                </button>
              ))}
            </>
          )}
            </>
          )}
        </Popup>
      )}
      {viewer && <CellViewer result={result} order={order} at={viewer} onClose={() => (setViewer(null), scrollRef.current?.focus())} onCopy={(t) => copy(t, "value")} />}
    </div>
  );
}

function Popup({ x, y, alignRight, onClose, children }: { x: number; y: number; alignRight: boolean; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = clamp(alignRight ? x - w : x, 4, window.innerWidth - w - 4);
    // Below the point if it fits, else above it, else pinned to the top (the menu scrolls; panels can be short).
    const top = y + h <= window.innerHeight - 4 ? y : y - h >= 4 ? y - h : Math.max(4, window.innerHeight - h - 4);
    setPos({ left, top });
  }, [x, y, alignRight]);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return (
    <div className="sqlg-menu" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>
  );
}

/** Full value of one cell — pretty JSON, long text, with wrap toggle and copy. Arrow keys step to neighbouring rows. */
function CellViewer({ result, order, at, onClose, onCopy }: { result: ResultSet; order: number[]; at: { row: number; col: number }; onClose: () => void; onCopy: (text: string) => void }) {
  const [pos, setPos] = useState(at);
  const [wrap, setWrap] = useState(true);
  const col = result.columns[pos.col]!;
  const src = order[pos.row]!;
  const value = result.rows[src]?.[pos.col];
  const { text, json } = prettyValue(value);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => ref.current?.focus(), []);
  const step = (dr: number, dc: number) => setPos((p) => ({ row: clamp(p.row + dr, 0, order.length - 1), col: clamp(p.col + dc, 0, result.columns.length - 1) }));
  return (
    <div className="sqlg-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sqlg-viewer"
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.altKey || e.target === ref.current) {
            if (e.key === "ArrowDown") step(1, 0);
            else if (e.key === "ArrowUp") step(-1, 0);
            else if (e.key === "ArrowRight") step(0, 1);
            else if (e.key === "ArrowLeft") step(0, -1);
            else return;
            e.preventDefault();
          }
        }}
      >
        <div className="sqlg-viewer-head">
          <strong>{col.name}</strong>
          <span className="sqlg-dim">
            {col.type} · row {src + 1}
            {json ? " · JSON" : ""} · {typeof value === "string" ? `${value.length.toLocaleString()} chars` : value === null || value === undefined ? "NULL" : typeof value}
          </span>
          <span className="sqlg-spacer" />
          <button className="sqlg-btn" onClick={() => step(-1, 0)} title="Previous row (↑)">
            ↑
          </button>
          <button className="sqlg-btn" onClick={() => step(1, 0)} title="Next row (↓)">
            ↓
          </button>
          <button className={`sqlg-btn ${wrap ? "on" : ""}`} onClick={() => setWrap(!wrap)}>
            Wrap
          </button>
          <button className="sqlg-btn" onClick={() => onCopy(json ? text : display(value))}>
            Copy
          </button>
          <button className="sqlg-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <pre className={`sqlg-viewer-body ${wrap ? "wrap" : ""} ${value === null || value === undefined ? "null" : ""}`}>{text}</pre>
      </div>
    </div>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Grid cells are one line: long text and newlines are shortened (the viewer shows all of it). */
function cellText(v: unknown): string {
  const s = display(v);
  return s.length > 500 ? `${s.slice(0, 500).replace(/\s+/g, " ")}…` : s.replace(/\s*[\r\n]+\s*/g, " ⏎ ");
}

/** "Count 12 · Sum 340 · Avg 28.33" for a multi-cell selection (numbers only for sum/avg/min/max). */
function selectionStats(rows: unknown[][]): string {
  let cells = 0;
  let nums = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    for (const v of row) {
      cells++;
      if (v === null || v === undefined || v === "" || typeof v === "boolean") continue;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) continue;
      nums++;
      sum += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }
  }
  const f = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return nums ? `Count ${f(cells)} · Sum ${f(sum)} · Avg ${f(sum / nums)} · Min ${f(min)} · Max ${f(max)}` : `Count ${f(cells)}`;
}

function initialWidths(result: ResultSet): number[] {
  return result.columns.map((col, i) => {
    let longest = col.name.length + 2;
    for (const row of result.rows.slice(0, 100)) longest = Math.max(longest, Math.min(60, display(row[i]).length));
    return Math.min(360, Math.max(60, longest * 7.5 + 18));
  });
}

function download(name: string, data: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(data);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** execCommand works inside the sandboxed view without clipboard permissions (it's a user gesture). */
export function copyText(text: string): void {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  el.remove();
}
