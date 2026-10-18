import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * Find / Replace and Go to Line for a <textarea> editor (Ctrl+F, Ctrl+H, Ctrl+G, F3) — VS Code style: a small
 * widget in the top-right corner, every match marked in the text, the current one stronger. Focus stays in the
 * widget while stepping through matches, so the marks (not the textarea selection) show where you are.
 *
 * Used by FeatureEditor; any other textarea editor can host it too: render <FindWidget> and <FindMarks> inside the
 * positioned element that holds the textarea, with the textarea's padding and line height.
 */

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}
export interface FindMatch {
  start: number;
  end: number;
}

const MAX_MATCHES = 20_000;

/** Every match of `query` in `text` (capped), or the regex error. */
export function findMatches(text: string, query: string, o: FindOptions): { matches: FindMatch[]; error?: string; capped: boolean } {
  if (!query) return { matches: [], capped: false };
  let re: RegExp;
  try {
    const source = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(o.wholeWord ? `\\b(?:${source})\\b` : source, o.caseSensitive ? "gm" : "gim");
  } catch (err) {
    return { matches: [], error: err instanceof Error ? err.message : String(err), capped: false };
  }
  const matches: FindMatch[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++; // an empty regex match (e.g. ^) — skip it, or the loop never advances
      continue;
    }
    matches.push({ start: m.index, end: m.index + m[0].length });
    if (matches.length >= MAX_MATCHES) return { matches, capped: true };
  }
  return { matches, capped: false };
}

/** The replacement for one match: `$1`, `$&` … expand in regex mode, like VS Code. */
export function replacementFor(text: string, match: FindMatch, query: string, replacement: string, o: FindOptions): string {
  if (!o.regex) return replacement;
  const source = o.wholeWord ? `\\b(?:${query})\\b` : query;
  const re = new RegExp(source, o.caseSensitive ? "m" : "im");
  return text.slice(match.start, match.end).replace(re, replacement);
}

/** The whole text with every match replaced (one pass, so replacements are never re-matched). */
export function replaceAll(text: string, query: string, replacement: string, o: FindOptions): { text: string; count: number } {
  const { matches } = findMatches(text, query, o);
  if (!matches.length) return { text, count: 0 };
  let out = "";
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.start) + replacementFor(text, m, query, replacement, o);
    last = m.end;
  }
  return { text: out + text.slice(last), count: matches.length };
}

export interface Geometry {
  /** Textarea padding (px). */
  paddingTop: number;
  paddingLeft: number;
  lineHeight: number;
  tabSize: number;
}

/** Line index and visual column (tabs expanded) of an offset. */
function position(text: string, offset: number, tabSize: number): { line: number; col: number } {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  let line = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  let col = 0;
  for (let i = lineStart; i < offset; i++) col = text[i] === "\t" ? col + tabSize - (col % tabSize) : col + 1;
  return { line, col };
}

/** Width of one character of the textarea's (monospace) font. */
function useCharWidth(textareaRef: RefObject<HTMLTextAreaElement>): number {
  const [width, setWidth] = useState(8.4);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    const style = getComputedStyle(el);
    ctx.font = `${style.fontSize} ${style.fontFamily}`;
    setWidth(ctx.measureText("0".repeat(100)).width / 100);
  }, [textareaRef]);
  return width;
}

/** Scroll the textarea so a match is in view (it doesn't do that by itself for an unfocused selection). */
export function scrollToMatch(el: HTMLTextAreaElement, match: FindMatch, g: Geometry, charWidth: number) {
  const { line, col } = position(el.value, match.start, g.tabSize);
  const top = g.paddingTop + line * g.lineHeight;
  if (top < el.scrollTop + g.lineHeight || top > el.scrollTop + el.clientHeight - 3 * g.lineHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
  const left = g.paddingLeft + col * charWidth;
  if (left < el.scrollLeft || left > el.scrollLeft + el.clientWidth - 60) el.scrollLeft = Math.max(0, left - el.clientWidth / 3);
}

/** Boxes behind the text marking the matches in view (the current one stronger). Place it under the textarea. */
export function FindMarks({ textareaRef, text, matches, current, geometry }: { textareaRef: RefObject<HTMLTextAreaElement>; text: string; matches: FindMatch[]; current: number; geometry: Geometry }) {
  const charWidth = useCharWidth(textareaRef);
  const [scroll, setScroll] = useState({ top: 0, left: 0, height: 0 });
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const update = () => setScroll({ top: el.scrollTop, left: el.scrollLeft, height: el.clientHeight });
    update();
    el.addEventListener("scroll", update);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [textareaRef]);

  // Line starts once per text, so each visible match is placed without rescanning the document.
  const lineStarts = useMemo(() => {
    const starts = [0];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
    return starts;
  }, [text]);
  if (!matches.length) return null;

  const firstLine = Math.max(0, Math.floor((scroll.top - geometry.paddingTop) / geometry.lineHeight) - 1);
  const lastLine = firstLine + Math.ceil(scroll.height / geometry.lineHeight) + 2;
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const visualCol = (lineStart: number, offset: number) => {
    let col = 0;
    for (let i = lineStart; i < offset; i++) col = text[i] === "\t" ? col + geometry.tabSize - (col % geometry.tabSize) : col + 1;
    return col;
  };

  const boxes: JSX.Element[] = [];
  for (let i = 0; i < matches.length && boxes.length < 500; i++) {
    const m = matches[i]!;
    const line = lineOf(m.start);
    if (line < firstLine) continue;
    if (line > lastLine) break;
    const startCol = visualCol(lineStarts[line]!, m.start);
    const endOffset = Math.min(m.end, (lineStarts[line + 1] ?? text.length + 1) - 1); // a multi-line match is marked on its first line
    const endCol = visualCol(lineStarts[line]!, Math.max(endOffset, m.start + 1));
    boxes.push(
      <div
        key={i}
        className={`oce-find-mark ${i === current ? "current" : ""}`}
        style={{
          top: geometry.paddingTop + line * geometry.lineHeight - scroll.top,
          left: geometry.paddingLeft + startCol * charWidth - scroll.left,
          width: Math.max(2, (endCol - startCol) * charWidth),
          height: geometry.lineHeight,
        }}
      />,
    );
  }
  return (
    <div className="oce-find-marks" aria-hidden>
      {boxes}
    </div>
  );
}

export type FindMode = "find" | "replace";

/**
 * The find / replace box. `request` (bumped by Ctrl+F / Ctrl+H) opens or refocuses it, seeded with the selection.
 * Reports the matches (for <FindMarks>) through `onMatches`.
 */
export function FindWidget({
  textareaRef,
  text,
  readOnly,
  request,
  geometry,
  onMatches,
  onReplaceAll,
  onSelect,
  onClose,
}: {
  textareaRef: RefObject<HTMLTextAreaElement>;
  text: string;
  readOnly: boolean;
  /** Bump `nonce` to open / refocus; `next` steps to the next (+1) or previous (-1) match (F3 / Shift+F3). */
  request: { mode: FindMode; nonce: number; step?: 1 | -1 };
  geometry: Geometry;
  onMatches: (matches: FindMatch[], current: number) => void;
  /** Replace the whole document as one undoable edit. */
  onReplaceAll: (next: string) => void;
  /** The selection moved (cursor position in the status bar). */
  onSelect: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [mode, setMode] = useState<FindMode>(request.mode);
  const [options, setOptions] = useState<FindOptions>({ caseSensitive: false, wholeWord: false, regex: false });
  const [current, setCurrent] = useState(-1);
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const charWidth = useCharWidth(textareaRef);

  const { matches, error, capped } = useMemo(() => findMatches(text, query, options), [text, query, options]);

  // Open / refocus: seed with a short single-line selection, like VS Code.
  const lastNonce = useRef(-1);
  useEffect(() => {
    if (lastNonce.current === request.nonce) return;
    const first = lastNonce.current === -1;
    lastNonce.current = request.nonce;
    if (request.step && !first) {
      go(request.step);
      return;
    }
    setMode(readOnly ? "find" : request.mode);
    const el = textareaRef.current;
    const selected = el ? el.value.slice(el.selectionStart, el.selectionEnd) : "";
    if (selected && !selected.includes("\n") && selected.length < 200) setQuery(selected);
    requestAnimationFrame(() => {
      const target = request.mode === "replace" && !readOnly && selected ? replaceInput.current : findInput.current;
      target?.focus();
      target?.select();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // Matches changed (typing in the box, or the document changed): keep the current one near the caret.
  useEffect(() => {
    const el = textareaRef.current;
    if (!matches.length || !el) {
      setCurrent(-1);
      return;
    }
    const caret = el.selectionStart;
    const i = matches.findIndex((m) => m.end > caret);
    setCurrent(i === -1 ? 0 : i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  useEffect(() => onMatches(matches, current), [matches, current, onMatches]);
  useEffect(() => () => onMatches([], -1), [onMatches]);

  function select(i: number) {
    const el = textareaRef.current;
    const m = matches[i];
    if (!el || !m) return;
    setCurrent(i);
    el.setSelectionRange(m.start, m.end);
    scrollToMatch(el, m, geometry, charWidth);
    onSelect();
  }

  function go(dir: 1 | -1) {
    if (!matches.length) return;
    const base = current === -1 ? (dir === 1 ? -1 : 0) : current;
    select((base + dir + matches.length) % matches.length);
  }

  function replaceOne() {
    const el = textareaRef.current;
    const m = matches[current];
    if (!el || !m || readOnly) return;
    const with_ = replacementFor(text, m, query, replacement, options);
    el.focus();
    el.setSelectionRange(m.start, m.end);
    // execCommand keeps it on the textarea's native undo stack.
    document.execCommand("insertText", false, with_);
    replaceInput.current?.focus();
  }

  function replaceEverything() {
    if (readOnly) return;
    const r = replaceAll(text, query, replacement, options);
    if (r.count) onReplaceAll(r.text);
  }

  function close() {
    const el = textareaRef.current;
    const m = matches[current];
    onClose();
    if (el) {
      el.focus();
      if (m) el.setSelectionRange(m.start, m.end);
    }
  }

  const onKey = (e: React.KeyboardEvent, inReplace: boolean) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && inReplace && (e.ctrlKey || e.metaKey) && e.altKey) {
      e.preventDefault();
      replaceEverything();
    } else if (e.key === "Enter" && inReplace) {
      e.preventDefault();
      replaceOne();
    } else if (e.key === "Enter" || e.key === "F3") {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if (e.altKey && !e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === "c" || k === "w" || k === "r") {
        e.preventDefault();
        setOptions((o) => ({ ...o, ...(k === "c" ? { caseSensitive: !o.caseSensitive } : k === "w" ? { wholeWord: !o.wholeWord } : { regex: !o.regex }) }));
      }
    }
  };

  const count = !query ? "" : error ? "Invalid regex" : matches.length === 0 ? "No results" : `${current + 1} of ${matches.length}${capped ? "+" : ""}`;
  const toggle = (key: keyof FindOptions, label: React.ReactNode, title: string) => (
    <button className={`oce-find-toggle ${options[key] ? "on" : ""}`} title={title} onClick={() => setOptions((o) => ({ ...o, [key]: !o[key] }))}>
      {label}
    </button>
  );

  return (
    <div className="oce-find" role="dialog" aria-label="Find">
      {!readOnly && (
        <button className="oce-find-expand" title="Toggle Replace" onClick={() => setMode(mode === "find" ? "replace" : "find")}>
          {mode === "replace" ? "▾" : "▸"}
        </button>
      )}
      <div className="oce-find-rows">
        <div className="oce-find-row">
          <div className={`oce-find-field ${error ? "invalid" : ""}`}>
            <input ref={findInput} value={query} placeholder="Find" spellCheck={false} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => onKey(e, false)} title={error} />
            {toggle("caseSensitive", "Aa", "Match Case (Alt+C)")}
            {toggle("wholeWord", <u>ab</u>, "Match Whole Word (Alt+W)")}
            {toggle("regex", ".*", "Use Regular Expression (Alt+R)")}
          </div>
          <span className={`oce-find-count ${query && !matches.length ? "none" : ""}`}>{count}</span>
          <button className="oce-find-btn" title="Previous Match (Shift+Enter)" disabled={!matches.length} onClick={() => go(-1)}>
            ↑
          </button>
          <button className="oce-find-btn" title="Next Match (Enter)" disabled={!matches.length} onClick={() => go(1)}>
            ↓
          </button>
          <button className="oce-find-btn" title="Close (Escape)" onClick={close}>
            ✕
          </button>
        </div>
        {mode === "replace" && !readOnly && (
          <div className="oce-find-row">
            <div className="oce-find-field">
              <input
                ref={replaceInput}
                value={replacement}
                placeholder={options.regex ? "Replace ($1 for groups)" : "Replace"}
                spellCheck={false}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={(e) => onKey(e, true)}
              />
            </div>
            <button className="oce-find-btn wide" title="Replace (Enter)" disabled={current === -1} onClick={replaceOne}>
              Replace
            </button>
            <button className="oce-find-btn wide" title="Replace All (Ctrl+Alt+Enter)" disabled={!matches.length} onClick={replaceEverything}>
              All
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Ctrl+G: "Go to line" box. */
export function GoToLine({ lineCount, onGo, onClose }: { lineCount: number; onGo: (line: number, col: number) => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const parsed = /^\s*(\d+)(?:\s*[:,]\s*(\d+))?\s*$/.exec(value);
  const line = parsed ? Number(parsed[1]) : NaN;
  const valid = Number.isInteger(line) && line >= 1 && line <= lineCount;
  return (
    <div className="oce-find oce-goto" role="dialog" aria-label="Go to Line">
      <div className="oce-find-rows">
        <div className="oce-find-row">
          <div className={`oce-find-field ${value && !valid ? "invalid" : ""}`}>
            <input
              ref={input}
              value={value}
              placeholder={`Go to line (1 – ${lineCount}), or line:column`}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onClose();
                else if (e.key === "Enter" && valid) onGo(line, parsed?.[2] ? Number(parsed[2]) : 1);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
