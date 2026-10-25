import { type ReactNode, type RefObject, useMemo, useRef } from "react";

const LINE_HEIGHT = 20;

/**
 * Line numbers + text. When another plugin supplies syntax tokens, a highlighted copy of the text is drawn
 * *under* the textarea (whose own text becomes transparent) — the textarea stays the real editor, so
 * selection, undo, IME and autocomplete all keep working.
 *
 * Both layers must share font, padding, tab size and wrapping exactly, and the highlight classes only ever
 * change color (never weight or style), so the glyphs line up pixel for pixel.
 */
export function EditorSurface({
  text,
  onChange,
  textareaRef,
  highlightHtml,
  cursorLine,
  onKeyDown,
  onCursor,
  onScrollFraction,
  readOnly = false,
  underlay,
  lenses,
  onLens,
}: {
  /** ▶ buttons in the gutter (0-based `line`), e.g. "Send Request". */
  lenses?: ReadonlyArray<{ line: number; title: string }>;
  onLens?: (index: number) => void;
  /** Drawn between the highlight layer and the textarea (e.g. find-match marks). */
  underlay?: ReactNode;
  text: string;
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  readOnly?: boolean;
  /** Markup for the highlight layer, or null for a plain editor. */
  highlightHtml: string | null;
  cursorLine: number;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCursor: () => void;
  /** Called with the editor's scroll position as a 0–1 fraction (for scroll-synced previews). */
  onScrollFraction?: ((fraction: number) => void) | undefined;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLPreElement>(null);

  const lineCount = useMemo(() => {
    let n = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  }, [text]);
  // One text block instead of one element per line: a 20,000-line file would otherwise re-render 20,000 nodes per keystroke.
  const numbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join("\n"), [lineCount]);

  function onScroll(e: React.UIEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    if (gutterRef.current) gutterRef.current.scrollTop = el.scrollTop;
    if (layerRef.current) {
      layerRef.current.scrollTop = el.scrollTop;
      layerRef.current.scrollLeft = el.scrollLeft;
    }
    const range = el.scrollHeight - el.clientHeight;
    onScrollFraction?.(range > 0 ? el.scrollTop / range : 0);
  }

  const highlighted = highlightHtml !== null;
  return (
    <div className="oce-surface">
      <div className="oce-gutter" ref={gutterRef} aria-hidden>
        <div className="oce-gutter-inner">
          <pre className="oce-gutter-numbers">{numbers}</pre>
          {lenses?.map((l, i) => (
            <button key={`${l.line}-${i}`} className="oce-lens" style={{ top: 8 + l.line * LINE_HEIGHT }} title={l.title} aria-label={l.title} onClick={() => onLens?.(i)}>
              ▶
            </button>
          ))}
          <div className="oce-gutter-current" style={{ top: (cursorLine - 1) * LINE_HEIGHT }}>
            {cursorLine}
          </div>
        </div>
      </div>
      <div className="oce-text-layer">
        {highlighted && <pre ref={layerRef} className="oce-hl" aria-hidden dangerouslySetInnerHTML={{ __html: highlightHtml }} />}
        {underlay}
        <textarea
          ref={textareaRef}
          className={highlighted ? "oce-transparent" : undefined}
          value={text}
          spellCheck={false}
          autoFocus
          readOnly={readOnly}
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onKeyUp={onCursor}
          onClick={onCursor}
          onSelect={onCursor}
          onScroll={onScroll}
        />
      </div>
    </div>
  );
}
