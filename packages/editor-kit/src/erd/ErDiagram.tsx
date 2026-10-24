import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  type ColumnMode,
  type ErModel,
  type ErTable,
  HEADER,
  type Layout,
  ROW,
  bounds,
  edgeGeometry,
  layoutModel,
  toDbml,
  toMermaid,
  toSvg,
  visibleColumns,
} from "./model.js";

interface View {
  x: number;
  y: number;
  k: number;
}

export interface ErDiagramProps {
  model: ErModel;
  /** Remembers dragged positions per diagram (e.g. "<connection>/<database>/<schema>"). */
  storageKey?: string;
  /** Double-click on a table (e.g. open its rows). */
  onOpenTable?: (table: ErTable) => void;
  /** Start with this table selected and in view (opened from a table in the explorer). */
  focus?: string | undefined;
  onReload?: () => void;
}

const loadPositions = (key?: string): Layout => {
  if (!key) return {};
  try {
    return JSON.parse(localStorage.getItem(`oneclient.erd:${key}`) ?? "{}") as Layout;
  } catch {
    return {};
  }
};
const savePositions = (key: string | undefined, moved: Layout) => {
  if (!key) return;
  try {
    localStorage.setItem(`oneclient.erd:${key}`, JSON.stringify(moved));
  } catch {
    // storage unavailable: positions just aren't remembered
  }
};

function download(name: string, data: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(data);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function svgToPng(svg: string): Promise<Blob> {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Couldn't render the diagram."));
      img.src = url;
    });
    const scale = Math.min(2, 16000 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG export failed."))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The entity–relationship diagram of a database: tables placed automatically (parents left of the tables that
 * reference them), crow's-foot lines between key columns. Drag the background to pan, the wheel to zoom, a table's
 * header to move it; click a table to follow its relations; export as SVG, PNG, Mermaid or DBML.
 */
export function ErDiagram({ model, storageKey, onOpenTable, focus, onReload }: ErDiagramProps) {
  const [mode, setMode] = useState<ColumnMode>("all");
  const [schema, setSchema] = useState<string>("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  const [moved, setMoved] = useState<Layout>(() => loadPositions(storageKey));
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [message, setMessage] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: "pan" | "table"; id?: string | undefined; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  const schemas = useMemo(() => [...new Set(model.tables.map((t) => t.schema))].sort(), [model]);
  const shownModel = useMemo<ErModel>(() => {
    if (!schema) return model;
    const tables = model.tables.filter((t) => t.schema === schema);
    const ids = new Set(tables.map((t) => t.id));
    return { ...model, tables, relations: model.relations.filter((r) => ids.has(r.from) && ids.has(r.to)) };
  }, [model, schema]);
  const tablesById = useMemo(() => new Map(shownModel.tables.map((t) => [t.id, t])), [shownModel]);
  const auto = useMemo(() => layoutModel(shownModel, mode), [shownModel, mode]);
  // Dragged tables keep their place; their size follows the column mode.
  const layout = useMemo<Layout>(() => {
    const out: Layout = {};
    for (const [id, b] of Object.entries(auto)) {
      const m = moved[id];
      out[id] = m ? { ...b, x: m.x, y: m.y } : b;
    }
    return out;
  }, [auto, moved]);

  // What to highlight: the selected table and its neighbours, or search matches.
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? new Set(shownModel.tables.filter((t) => t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase() === q)).map((t) => t.id)) : null), [q, shownModel]);
  const related = useMemo(() => {
    if (!selected) return null;
    const ids = new Set([selected]);
    const rels = new Set<string>();
    for (const r of shownModel.relations) {
      if (r.from === selected || r.to === selected) {
        ids.add(r.from);
        ids.add(r.to);
        rels.add(r.id);
      }
    }
    return { ids, rels };
  }, [selected, shownModel]);
  const lit = (id: string) => (related ? related.ids.has(id) : matches ? matches.has(id) : true);

  const fit = (ids?: Iterable<string>) => {
    const el = host.current;
    if (!el) return;
    const b = bounds(layout, ids);
    if (!b.w) return;
    const pad = 40;
    const k = Math.min(1.25, Math.max(0.08, Math.min((el.clientWidth - pad * 2) / b.w, (el.clientHeight - pad * 2) / b.h)));
    setView({ k, x: (el.clientWidth - b.w * k) / 2 - b.x * k, y: (el.clientHeight - b.h * k) / 2 - b.y * k });
  };
  // First draw: fit everything, or the focused table with its neighbours.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !Object.keys(layout).length) return;
    fitted.current = true;
    requestAnimationFrame(() => fit(related ? related.ids : undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  const zoomAt = (factor: number, cx: number, cy: number) =>
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.08, v.k * factor));
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
      else setView((v) => ({ ...v, x: v.x - e.deltaX }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent, tableId?: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const b = tableId ? layout[tableId] : undefined;
    drag.current = b
      ? { kind: "table", id: tableId, sx: e.clientX, sy: e.clientY, ox: b.x, oy: b.y, moved: false }
      : { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.kind === "pan") setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    else if (d.id && d.moved) setMoved((m) => ({ ...m, [d.id!]: { x: Math.round(d.ox + dx / view.k), y: Math.round(d.oy + dy / view.k), w: 0, h: 0 } }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "table" && d.moved) setMoved((m) => (savePositions(storageKey, m), m));
    else if (!d.moved) setSelected(d.kind === "table" ? (selected === d.id ? null : d.id!) : null);
  };

  const flash = (text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(null), 2500);
  };
  const base = `${model.database || "database"}${schema ? `-${schema}` : ""}`;
  const exportAs = async (kind: "svg" | "png" | "mermaid" | "dbml" | "copy-mermaid") => {
    try {
      if (kind === "copy-mermaid") {
        await navigator.clipboard.writeText(toMermaid(shownModel));
        return flash("Mermaid copied — paste it into a Markdown file, a GitHub issue or a wiki.");
      }
      if (kind === "mermaid") return download(`${base}.mmd`, new Blob([toMermaid(shownModel)], { type: "text/plain" }));
      if (kind === "dbml") return download(`${base}.dbml`, new Blob([toDbml(shownModel)], { type: "text/plain" }));
      const svg = toSvg(shownModel, layout, mode);
      if (kind === "svg") return download(`${base}.svg`, new Blob([svg], { type: "image/svg+xml" }));
      download(`${base}.png`, await svgToPng(svg));
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    }
  };

  const relayout = () => {
    setMoved({});
    savePositions(storageKey, {});
    fitted.current = false;
  };
  const centerOn = (id: string) => {
    setSelected(id);
    fit([id, ...shownModel.relations.filter((r) => r.from === id || r.to === id).flatMap((r) => [r.from, r.to])]);
  };

  return (
    <div className="erd">
      <div className="erd-toolbar">
        <input
          className="erd-search"
          placeholder="Find a table or column…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches?.size) centerOn([...matches][0]!);
            if (e.key === "Escape") setQuery("");
          }}
        />
        {schemas.length > 1 && (
          <select className="erd-select" value={schema} onChange={(e) => setSchema(e.target.value)} title="Schema">
            <option value="">All schemas</option>
            {schemas.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        )}
        <div className="erd-seg" role="group" aria-label="Columns">
          {(["all", "keys", "none"] as const).map((m) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
              {m === "all" ? "All columns" : m === "keys" ? "Keys" : "Names"}
            </button>
          ))}
        </div>
        <div className="erd-spacer" />
        <button className="erd-btn" title="Zoom out" onClick={() => zoomAt(1 / 1.2, (host.current?.clientWidth ?? 0) / 2, (host.current?.clientHeight ?? 0) / 2)}>
          −
        </button>
        <span className="erd-zoom">{Math.round(view.k * 100)}%</span>
        <button className="erd-btn" title="Zoom in" onClick={() => zoomAt(1.2, (host.current?.clientWidth ?? 0) / 2, (host.current?.clientHeight ?? 0) / 2)}>
          +
        </button>
        <button className="erd-btn" onClick={() => fit()}>Fit</button>
        <button className="erd-btn" title="Discard moved positions and lay everything out again" onClick={relayout}>
          Re-layout
        </button>
        {onReload && (
          <button className="erd-btn" title="Read the schema again" onClick={onReload}>
            Refresh
          </button>
        )}
        <details className="erd-menu">
          <summary className="erd-btn">Export</summary>
          <div className="erd-menu-list" onClick={(e) => ((e.currentTarget.parentElement as HTMLDetailsElement).open = false)}>
            <button onClick={() => void exportAs("png")}>PNG image</button>
            <button onClick={() => void exportAs("svg")}>SVG image</button>
            <button onClick={() => void exportAs("mermaid")}>Mermaid (.mmd)</button>
            <button onClick={() => void exportAs("copy-mermaid")}>Copy Mermaid</button>
            <button onClick={() => void exportAs("dbml")}>DBML (dbdiagram.io)</button>
          </div>
        </details>
      </div>

      <div className="erd-canvas" ref={host} onPointerDown={(e) => onPointerDown(e)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        {shownModel.tables.length === 0 ? (
          <div className="erd-empty">No tables here.</div>
        ) : (
          <svg width="100%" height="100%">
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              <g className="erd-edges">
                {shownModel.relations.map((r) => {
                  const g = edgeGeometry(r, tablesById, layout, mode);
                  if (!g) return null;
                  const on = related ? related.rels.has(r.id) : matches ? matches.has(r.from) || matches.has(r.to) : true;
                  return (
                    <g key={r.id} className={`erd-edge${related?.rels.has(r.id) ? " hot" : ""}${on ? "" : " dim"}`}>
                      <title>{`${r.name}: ${tablesById.get(r.from)?.name}(${r.fromColumns.join(", ")}) → ${tablesById.get(r.to)?.name}(${r.toColumns.join(", ")})${r.onDelete ? ` · on delete ${r.onDelete}` : ""}`}</title>
                      <path d={g.path} />
                      <path d={g.childGlyph} />
                      <path d={g.parentGlyph} />
                      {g.optional && <circle cx={g.optional.cx} cy={g.optional.cy} r={3.5} />}
                    </g>
                  );
                })}
              </g>
              {shownModel.tables.map((t) => {
                const b = layout[t.id];
                if (!b) return null;
                const { columns, hidden } = visibleColumns(t, mode);
                return (
                  <g
                    key={t.id}
                    className={`erd-table${t.kind === "view" ? " view" : ""}${selected === t.id ? " selected" : ""}${lit(t.id) ? "" : " dim"}`}
                    transform={`translate(${b.x} ${b.y})`}
                    onPointerDown={(e) => onPointerDown(e, t.id)}
                    onDoubleClick={() => onOpenTable?.(t)}
                  >
                    <title>{`${t.schema}.${t.name}${t.comment ? `\n${t.comment}` : ""}`}</title>
                    <rect className="erd-box" width={b.w} height={b.h} rx={6} />
                    <path className="erd-head" d={`M0 6a6 6 0 0 1 6-6H${b.w - 6}a6 6 0 0 1 6 6V${HEADER}H0z`} />
                    <text className="erd-name" x={12} y={HEADER / 2 + 4.5}>
                      {t.name}
                    </text>
                    {t.kind === "view" && (
                      <text className="erd-tag" x={b.w - 10} y={HEADER / 2 + 4} textAnchor="end">
                        view
                      </text>
                    )}
                    {schemas.length > 1 && !schema && (
                      <text className="erd-tag" x={b.w - (t.kind === "view" ? 44 : 10)} y={HEADER / 2 + 4} textAnchor="end">
                        {t.schema}
                      </text>
                    )}
                    {columns.map((c, i) => {
                      const y = HEADER + i * ROW + ROW / 2 + 4.5;
                      return (
                        <g key={c.name} className={c.pk ? "pk" : c.fk ? "fk" : ""}>
                          {(c.pk || c.fk) && (
                            <text className="erd-key" x={10} y={y}>
                              {c.pk ? "PK" : "FK"}
                            </text>
                          )}
                          <text className={`erd-col${c.nullable ? "" : " required"}`} x={32} y={y}>
                            {c.name}
                          </text>
                          <text className="erd-type" x={b.w - 10} y={y} textAnchor="end">
                            {c.type}
                          </text>
                        </g>
                      );
                    })}
                    {hidden > 0 && mode === "all" && (
                      <text className="erd-more" x={32} y={HEADER + columns.length * ROW + ROW / 2 + 4}>
                        +{hidden} more
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        {message && <div className="erd-toast">{message}</div>}
      </div>

      <div className="erd-status">
        {shownModel.tables.length} tables · {shownModel.relations.length} relations
        {selected && tablesById.get(selected) && (
          <>
            {" "}
            · <strong>{tablesById.get(selected)!.name}</strong>: {related!.rels.size} relations — click the background to clear
          </>
        )}
        {model.truncated && <span className="erd-warn"> · Showing the first {model.tables.length} tables only</span>}
        <span className="erd-hint">Drag to pan · wheel to zoom · drag a header to move · double-click to open rows</span>
      </div>
    </div>
  );
}
