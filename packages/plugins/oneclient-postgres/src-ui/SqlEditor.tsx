import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CompletionProvider } from "@oneclient/editor-kit";
import { useAutocomplete } from "@oneclient/editor-kit/react";
import { highlightSql } from "./highlight.js";

const NO_PROVIDERS: readonly CompletionProvider[] = [];

export interface SqlEditorHandle {
  /** The selected text (if any) and the 1-based line it starts on; otherwise the whole script from line 1. */
  getRunnable(): { sql: string; lineOffset: number; isSelection: boolean };
  /** Move the caret to the start of a 1-based line and scroll it into view. */
  goToLine(line: number): void;
  focus(): void;
}

const LINE_HEIGHT = 19;

/**
 * Textarea with a syntax-highlighted <pre> drawn underneath it (the textarea's
 * own text is transparent), plus a line-number gutter — all three scroll together.
 */
export const SqlEditor = forwardRef<
  SqlEditorHandle,
  { value: string; onChange: (v: string) => void; completionProviders?: readonly CompletionProvider[] }
>(function SqlEditor({ value, onChange, completionProviders = NO_PROVIDERS }, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [cursorLine, setCursorLine] = useState(1);
  useAutocomplete(textareaRef, { providers: completionProviders });

  const html = useMemo(() => highlightSql(value), [value]);
  const lineCount = useMemo(() => value.split("\n").length, [value]);

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
