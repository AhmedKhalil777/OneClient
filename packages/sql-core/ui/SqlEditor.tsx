import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CompletionProvider } from "@oneclient/editor-kit";
import { useAutocomplete } from "@oneclient/editor-kit/react";
import { type FindMatch, FindMarks, type FindMode, FindWidget, type Geometry, GoToLine } from "@oneclient/editor-kit/editor";

const NO_PROVIDERS: readonly CompletionProvider[] = [];

export interface SqlEditorHandle {
  /** The selected text (if any) and the 1-based line it starts on; otherwise the whole script from line 1. */
  getRunnable(): { sql: string; lineOffset: number; isSelection: boolean };
  /** Move the caret to the start of a 1-based line and scroll it into view. */
  goToLine(line: number): void;
  /** Type text at the caret (replacing the selection), undoable with Ctrl+Z. */
  insertText(text: string): void;
  focus(): void;
}

const LINE_HEIGHT = 19;
/** .sql-input padding / tab size (styles.css), for placing find marks. */
const GEOMETRY: Geometry = { paddingTop: 6, paddingLeft: 8, lineHeight: LINE_HEIGHT, tabSize: 4 };

/**
 * Textarea with a syntax-highlighted <pre> drawn underneath it (the textarea's
 * own text is transparent), plus a line-number gutter — all three scroll together.
 */
export const SqlEditor = forwardRef<
  SqlEditorHandle,
  { value: string; onChange: (v: string) => void; highlight: (text: string) => string; completionProviders?: readonly CompletionProvider[] }
>(function SqlEditor({ value, onChange, highlight, completionProviders = NO_PROVIDERS }, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [cursorLine, setCursorLine] = useState(1);
  // Find / Replace (Ctrl+F / Ctrl+H, F3) and Go to Line (Ctrl+G), shared with the file editor.
  const [find, setFind] = useState<{ mode: FindMode; nonce: number; step?: 1 | -1 } | null>(null);
  const [marks, setMarks] = useState<{ matches: FindMatch[]; current: number }>({ matches: [], current: -1 });
  const onMatches = useCallback((matches: FindMatch[], current: number) => setMarks({ matches, current }), []);
  const [goToLine, setGoToLine] = useState(false);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.shiftKey && !e.altKey && (key === "f" || key === "h")) {
        e.preventDefault();
        setGoToLine(false);
        setFind((f) => ({ mode: key === "h" ? "replace" : "find", nonce: (f?.nonce ?? 0) + 1 }));
      } else if (mod && !e.shiftKey && !e.altKey && key === "g") {
        e.preventDefault();
        setFind(null);
        setGoToLine(true);
      } else if (e.key === "F3" && !mod) {
        e.preventDefault();
        setFind((f) => ({ mode: f?.mode ?? "find", nonce: (f?.nonce ?? 0) + 1, ...(f ? { step: e.shiftKey ? -1 : 1 } : {}) }));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useAutocomplete(textareaRef, { providers: completionProviders });

  const html = useMemo(() => highlight(value), [highlight, value]);
  const lineCount = useMemo(() => value.split("\n").length, [value]);

  function goToLineAt(line: number) {
    const el = textareaRef.current;
    if (!el) return;
    const lines = el.value.split("\n");
    const target = Math.min(Math.max(line, 1), lines.length);
    const offset = lines.slice(0, target - 1).reduce((n, l) => n + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(offset, offset);
    el.scrollTop = Math.max(0, (target - 1) * LINE_HEIGHT - el.clientHeight / 3);
    setCursorLine(target);
  }

  useImperativeHandle(ref, () => ({
    getRunnable() {
      const el = textareaRef.current;
      if (el && el.selectionEnd > el.selectionStart) {
        const sql = el.value.slice(el.selectionStart, el.selectionEnd);
        if (sql.trim()) {
          const lineOffset = el.value.slice(0, el.selectionStart).split("\n").length;
          return { sql, lineOffset, isSelection: true };
        }
      }
      return { sql: value, lineOffset: 1, isSelection: false };
    },
    goToLine(line) {
      const el = textareaRef.current;
      if (!el) return;
      const lines = el.value.split("\n");
      const target = Math.min(Math.max(line, 1), lines.length);
      const offset = lines.slice(0, target - 1).reduce((n, l) => n + l.length + 1, 0);
      el.focus();
      el.setSelectionRange(offset, offset + (lines[target - 1]?.length ?? 0));
      el.scrollTop = Math.max(0, (target - 1) * LINE_HEIGHT - el.clientHeight / 3);
      setCursorLine(target);
    },
    insertText(text) {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      // execCommand keeps the browser's undo stack; fall back to a plain splice.
      if (!document.execCommand("insertText", false, text)) onChange(el.value.slice(0, el.selectionStart) + text + el.value.slice(el.selectionEnd));
    },
    focus() {
      textareaRef.current?.focus();
    },
  }));

  function syncScroll() {
    const el = textareaRef.current;
    if (!el) return;
    if (preRef.current) {
      preRef.current.scrollTop = el.scrollTop;
      preRef.current.scrollLeft = el.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = el.scrollTop;
  }

  function updateCursor() {
    const el = textareaRef.current;
    if (el) setCursorLine(el.value.slice(0, el.selectionStart).split("\n").length);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      // execCommand keeps the edit on the textarea's native undo stack.
      if (!e.shiftKey) document.execCommand("insertText", false, "\t");
    }
  }

  return (
    <div className="sql-editor">
      <div className="sql-gutter" ref={gutterRef} aria-hidden>
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className={i + 1 === cursorLine ? "current" : undefined}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className="sql-surface">
        {find && <FindMarks textareaRef={textareaRef} text={value} matches={marks.matches} current={marks.current} geometry={GEOMETRY} />}
        {find && (
          <FindWidget
            textareaRef={textareaRef}
            text={value}
            readOnly={false}
            request={find}
            geometry={GEOMETRY}
            onMatches={onMatches}
            onReplaceAll={(next) => {
              const el = textareaRef.current;
              if (!el) return;
              el.focus();
              el.select();
              // execCommand keeps "replace all" on the native undo stack.
              document.execCommand("insertText", false, next);
            }}
            onSelect={updateCursor}
            onClose={() => setFind(null)}
          />
        )}
        {goToLine && (
          <GoToLine
            lineCount={value.split("\n").length}
            onClose={() => {
              setGoToLine(false);
              textareaRef.current?.focus();
            }}
            onGo={(line) => {
              setGoToLine(false);
              goToLineAt(line);
            }}
          />
        )}
        <pre ref={preRef} className="sql-highlight" aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
        <textarea
          ref={textareaRef}
          className="sql-input"
          value={value}
          spellCheck={false}
          autoFocus
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          onKeyUp={updateCursor}
          onClick={updateCursor}
          onSelect={updateCursor}
        />
      </div>
    </div>
  );
});
