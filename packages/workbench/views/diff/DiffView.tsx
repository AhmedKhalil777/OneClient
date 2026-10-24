import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { type DiffRow, diffLines, diffStats, sideBySide, toLines } from "@oneclient/backend/shared/diff.js";

type FileVersion = { kind: "text"; text: string } | { kind: "binary"; size: number } | { kind: "missing" };

const params = new URLSearchParams(location.search);
/** Repository root, repo-relative path (and where a rename came from), and the two sides. */
const root = params.get("root") ?? "";
const path = params.get("path") ?? "";
const origPath = params.get("origPath") ?? "";
const left = params.get("left") ?? "HEAD";
const right = params.get("right") ?? "worktree";

const CONTEXT = 3;
const sideName = (s: string) => (s === "worktree" ? "Working Tree" : s === "index" ? "Index" : s === "empty" ? "—" : s === "HEAD" ? "HEAD" : s.endsWith("^") ? `${s.slice(0, 7)}^` : s.slice(0, 7));

/** A block of rows: changed rows always show; long unchanged runs collapse to their context. */
type Block = { kind: "rows"; rows: DiffRow[] } | { kind: "fold"; rows: DiffRow[]; id: number };

function blocks(rows: DiffRow[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  let fold = 0;
  while (i < rows.length) {
    if (rows[i]!.kind !== "same") {
      const start = i;
      while (i < rows.length && rows[i]!.kind !== "same") i++;
      out.push({ kind: "rows", rows: rows.slice(start, i) });
      continue;
    }
    const start = i;
    while (i < rows.length && rows[i]!.kind === "same") i++;
    const run = rows.slice(start, i);
    const head = start === 0 ? 0 : CONTEXT;
    const tail = i === rows.length ? 0 : CONTEXT;
    if (run.length <= head + tail + 2) out.push({ kind: "rows", rows: run });
    else {
      if (head) out.push({ kind: "rows", rows: run.slice(0, head) });
      out.push({ kind: "fold", rows: run.slice(head, run.length - tail), id: fold++ });
      if (tail) out.push({ kind: "rows", rows: run.slice(run.length - tail) });
    }
  }
  return out;
}

/**
 * The diff tab (core view "git.diff"): a file in two versions — HEAD, the index, the working tree or a commit —
 * side by side or inline, unchanged regions folded, with next / previous change navigation.
 */
export function DiffView() {
  const [sides, setSides] = useState<{ left: FileVersion; right: FileVersion } | null>(null);
  const [error, setError] = useState("");
  const [inline, setInline] = useState(() => localStorage.getItem("oneclient.diff.inline") === "1");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [current, setCurrent] = useState(-1);
  const scroller = useRef<HTMLDivElement>(null);

  const load = () =>
    void (window.oneclientView.invokeCommand("git.diffContents", [{ root, path, origPath: origPath || undefined, left, right }]) as Promise<{ left: FileVersion; right: FileVersion }>)
      .then((r) => {
        setSides(r);
        setError("");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  useEffect(load, []);
  // The working tree side follows edits made elsewhere.
  useEffect(() => {
    if (right !== "worktree") return;
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const result = useMemo(() => {
    if (!sides || sides.left.kind === "binary" || sides.right.kind === "binary") return null;
    const a = sides.left.kind === "text" ? toLines(sides.left.text) : [];
    const b = sides.right.kind === "text" ? toLines(sides.right.text) : [];
    const ops = diffLines(a, b);
    const rows = sideBySide(a, b, ops);
    return { rows, stats: diffStats(ops), blocks: blocks(rows) };
  }, [sides]);

  // Indexes (into the rendered change blocks) for next / previous change.
  const changeAnchors = useRef<HTMLElement[]>([]);
  changeAnchors.current = [];
  const go = (dir: 1 | -1) => {
    const anchors = changeAnchors.current;
    if (!anchors.length) return;
    const next = (current + dir + anchors.length) % anchors.length;
    setCurrent(next);
    anchors[next]?.scrollIntoView({ block: "center" });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F7" || (e.altKey && e.key === "F5")) {
        e.preventDefault();
        go(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const absolute = `${root.replace(/[\\/]+$/, "")}${root.includes("\\") ? "\\" : "/"}${path.split("/").join(root.includes("\\") ? "\\" : "/")}`;
  const name = path.slice(path.lastIndexOf("/") + 1);

  const header = (
    <div className="diff-bar">
      <span className="diff-title" title={absolute}>
        {name} <span className="dim">({sideName(left)} ↔ {sideName(right)})</span>
      </span>
      {origPath && origPath !== path && <span className="dim">renamed from {origPath}</span>}
      {result && (
        <span className="diff-stats">
          <span className="add">+{result.stats.added}</span> <span className="del">−{result.stats.removed}</span>
        </span>
      )}
      <span className="spacer" />
      <button className="btn" onClick={() => go(-1)} disabled={!result?.stats.added && !result?.stats.removed} title="Previous change (Shift+F7)">
        ↑
      </button>
      <button className="btn" onClick={() => go(1)} disabled={!result?.stats.added && !result?.stats.removed} title="Next change (F7)">
        ↓
      </button>
      <button
        className={`btn ${inline ? "on" : ""}`}
        onClick={() => {
          localStorage.setItem("oneclient.diff.inline", inline ? "0" : "1");
          setInline(!inline);
        }}
        title="Inline / side by side"
      >
        {inline ? "Inline" : "Side by side"}
      </button>
      {right !== "empty" && (
        <button className="btn" onClick={() => void window.oneclientView.openFile(absolute)} title="Open the file in the editor">
          Open File
        </button>
      )}
    </div>
  );

  if (error) return <div className="diff-page">{header}<div className="diff-message error">{error}</div></div>;
  if (!sides) return <div className="diff-page">{header}<div className="diff-message">Loading…</div></div>;
  if (!result)
    return (
      <div className="diff-page">
        {header}
        <div className="diff-message">
          Binary file — {sides.left.kind === "binary" ? `${sides.left.size} bytes` : "—"} ↔ {sides.right.kind === "binary" ? `${sides.right.size} bytes` : "—"}
        </div>
      </div>
    );
  if (result.rows.length === 0 || (!result.stats.added && !result.stats.removed && sides.left.kind === sides.right.kind)) {
    return (
      <div className="diff-page">
        {header}
        <div className="diff-message">No changes{sides.left.kind === "text" && sides.left.text !== (sides.right.kind === "text" ? sides.right.text : "") ? " (only line endings or whitespace at the end differ)" : ""}.</div>
      </div>
    );
  }

  let changeIndex = 0;
  const anchor = (el: HTMLElement | null) => {
    if (el) changeAnchors.current.push(el);
  };

  return (
    <div className="diff-page">
      {header}
      <div className={`diff-body ${inline ? "inline" : "split"}`} ref={scroller}>
        {result.blocks.map((block, bi) => {
          if (block.kind === "fold" && !expanded.has(block.id)) {
            return (
              <div key={bi} className="diff-fold" onClick={() => setExpanded(new Set(expanded).add(block.id))} title="Show unchanged lines">
                ⋯ {block.rows.length} unchanged line{block.rows.length === 1 ? "" : "s"}
              </div>
            );
          }
          const isChange = block.kind === "rows" && block.rows[0]?.kind !== "same";
          const index = isChange ? changeIndex++ : -1;
          return (
            <div key={bi} ref={isChange ? anchor : undefined} className={isChange && index === current ? "diff-current" : undefined}>
              {block.rows.map((r, ri) => (inline ? <InlineRows key={ri} row={r} /> : <SplitRow key={ri} row={r} />))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Cell({ side, row }: { side: "left" | "right"; row: DiffRow }) {
  const cell = row[side];
  const kind = !cell ? "empty" : row.kind === "same" ? "same" : side === "left" ? "del" : "add";
  return (
    <>
      <span className={`ln ${kind}`}>{cell?.line ?? ""}</span>
      <span className={`code ${kind}`}>{cell ? cell.text || " " : ""}</span>
    </>
  );
}

function SplitRow({ row }: { row: DiffRow }) {
  return (
    <div className="row">
      <Cell side="left" row={row} />
      <Cell side="right" row={row} />
    </div>
  );
}

function InlineRows({ row }: { row: DiffRow }) {
  if (row.kind === "same") {
    return (
      <div className="row">
        <span className="ln same">{row.left?.line}</span>
        <span className="ln same">{row.right?.line}</span>
        <span className="code same">{row.right?.text || " "}</span>
      </div>
    );
  }
  return (
    <Fragment>
      {row.left && (
        <div className="row">
          <span className="ln del">{row.left.line}</span>
          <span className="ln del" />
          <span className="code del">{row.left.text || " "}</span>
        </div>
      )}
      {row.right && (
        <div className="row">
          <span className="ln add" />
          <span className="ln add">{row.right.line}</span>
          <span className="code add">{row.right.text || " "}</span>
        </div>
      )}
    </Fragment>
  );
}
