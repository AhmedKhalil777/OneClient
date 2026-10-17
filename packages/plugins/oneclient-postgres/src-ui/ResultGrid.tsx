import { useMemo, useRef, useState } from "react";
import type { ResultSet } from "./api.js";

const ROW_HEIGHT = 22;
const OVERSCAN = 8;

type Selection = { kind: "cell"; row: number; col: number } | { kind: "row"; row: number } | { kind: "all" } | null;

/**
 * Results grid: row numbers, NULLs highlighted, click a cell or
 * row number to select it, Ctrl+C copies (tab-separated), Ctrl+A selects
 * all. Only the visible rows are rendered, so 10k rows stay smooth.
 */
export function ResultGrid({ result, fill }: { result: ResultSet; fill: boolean }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  const [selection, setSelection] = useState<Selection>(null);
  const [widths, setWidths] = useState<number[]>(() => initialWidths(result));

  const { rows, columns } = result;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const rowNumWidth = useMemo(() => Math.max(36, String(rows.length).length * 8 + 16), [rows.length]);

  function onKeyDown(e: React.KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelection({ kind: "all" });
    } else if (mod && e.key.toLowerCase() === "c" && selection) {
      e.preventDefault();
      copyText(selectedText(result, selection, e.shiftKey));
      scrollRef.current?.focus();
    }
  }

  function startResize(col: number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = widths[col] ?? 100;
    const onMove = (ev: MouseEvent) =>
      setWidths((w) => w.map((x, i) => (i === col ? Math.max(40, startWidth + ev.clientX - startX) : x)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const totalWidth = rowNumWidth + widths.reduce((a, b) => a + b, 0);

  return (
    <div className={`grid-wrap ${fill ? "fill" : ""}`}>
      <div
        className="grid-scroll"
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
        style={fill ? undefined : { height: Math.min(300, ROW_HEIGHT * (rows.length + 1) + 18) }}
      >
        <div className="grid" style={{ width: totalWidth }}>
          <div className="grid-header" style={{ height: ROW_HEIGHT }}>
            <div
              className="grid-cell grid-rownum grid-corner"
              style={{ width: rowNumWidth }}
              onClick={() => setSelection({ kind: "all" })}
              title="Select all"
            />
            {columns.map((c, i) => (
              <div key={i} className="grid-cell grid-head" style={{ width: widths[i] }} title={`${c.name} (${c.type})`}>
                {c.name}
                <span className="grid-resize" onMouseDown={(e) => startResize(i, e)} />
              </div>
            ))}
          </div>
          <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
            {rows.slice(first, last).map((row, offset) => {
              const r = first + offset;
              const rowSelected = selection?.kind === "all" || (selection?.kind === "row" && selection.row === r);
              return (
                <div key={r} className={`grid-row ${rowSelected ? "selected" : ""}`} style={{ top: r * ROW_HEIGHT, height: ROW_HEIGHT }}>
                  <div className="grid-cell grid-rownum" style={{ width: rowNumWidth }} onClick={() => setSelection({ kind: "row", row: r })}>
                    {r + 1}
                  </div>
                  {row.map((value, c) => {
                    const cellSelected = selection?.kind === "cell" && selection.row === r && selection.col === c;
                    return (
                      <div
                        key={c}
                        className={`grid-cell ${value === null ? "null" : ""} ${typeof value === "number" ? "num" : ""} ${cellSelected ? "selected" : ""}`}
                        style={{ width: widths[c] }}
                        onClick={() => setSelection({ kind: "cell", row: r, col: c })}
                      >
                        {value === null ? "NULL" : String(value)}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {result.totalRows > rows.length && (
        <div className="grid-note">
          Showing the first {rows.length.toLocaleString()} of {result.totalRows.toLocaleString()} rows.
        </div>
      )}
    </div>
  );
}

function initialWidths(result: ResultSet): number[] {
  return result.columns.map((col, i) => {
    let longest = col.name.length;
    for (const row of result.rows.slice(0, 100)) {
      const v = row[i];
      longest = Math.max(longest, v === null ? 4 : String(v).length);
    }
    return Math.min(360, Math.max(60, longest * 7.5 + 18));
  });
}

function selectedText(result: ResultSet, selection: NonNullable<Selection>, withHeaders: boolean): string {
  const fmt = (v: unknown) => (v === null ? "NULL" : String(v));
  const line = (row: unknown[]) => row.map(fmt).join("\t");
  const header = result.columns.map((c) => c.name).join("\t");
  if (selection.kind === "cell") return fmt(result.rows[selection.row]?.[selection.col] ?? null);
  const body = selection.kind === "row" ? line(result.rows[selection.row] ?? []) : result.rows.map(line).join("\r\n");
  return withHeaders || selection.kind === "all" ? `${header}\r\n${body}` : body;
}

/** execCommand works inside the sandboxed view without clipboard permissions (it's a user gesture). */
function copyText(text: string): void {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  el.remove();
}
