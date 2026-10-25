import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompletionProvider, DocumentSymbol, FileEditorAction, TransformRequest, TransformResult } from "@oneclient/plugin-api";
import { wordsProvider } from "../providers/words.js";
import { Icon, useAutocomplete } from "../react.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { EditorSurface } from "./EditorSurface.js";
import { type PreviewHandle, PreviewPane } from "./PreviewPane.js";
import { caretAfterReplace, diffEdit, lineOf, mapBack, mapForward, shiftTokens } from "./edit.js";
import { FEATURE_TEXT_LIMIT, callFeature, useAnalysis, useFileFeatures } from "./features.js";
import { buildHighlightHtml } from "./highlight.js";
import { symbolPath } from "./symbols.js";
import { type FindMatch, FindMarks, type FindMode, FindWidget, type Geometry, GoToLine } from "./find.js";

const LINE_HEIGHT = 20;
/** The textarea's padding and tab size (editor.css), for placing find marks. */
const GEOMETRY: Geometry = { paddingTop: 8, paddingLeft: 4, lineHeight: LINE_HEIGHT, tabSize: 4 };
const DEFAULT_PROVIDERS: readonly CompletionProvider[] = [wordsProvider()];

interface Problem {
  message: string;
  /** Offset into the *current* text to jump to. */
  offset?: number | undefined;
}

export interface FeatureEditorProps {
  /** The document text. Always "\n" line endings — convert on load/save. */
  value: string;
  onChange: (value: string) => void;
  /** Base file name; what plugins' `oneclient.editors` contributions are matched against ("tsconfig.json"). */
  fileName: string;
  /** Path shown in the breadcrumb bar; defaults to `fileName`. */
  displayPath?: string;
  /** Text to detect the indentation from (e.g. the last saved version, so it doesn't change while typing). Defaults to `value`. */
  indentSource?: string;
  readOnly?: boolean;
  /** Toolbar, left side: replaces the file name. */
  toolbarStart?: ReactNode;
  /** Toolbar, right side: after the built-in Format / Actions / Preview buttons (Save, Revert, …). */
  toolbarEnd?: ReactNode;
  /** Status bar, left side, shown when there is no problem to report (e.g. "Saved 12:03"). */
  status?: ReactNode;
  /** Status bar, right side: extra items between the indentation and the language name (encoding, EOL…). */
  statusEnd?: ReactNode;
  /** Ctrl/Cmd+S pressed. */
  onSave?: () => void;
  completionProviders?: readonly CompletionProvider[];
  /**
   * Select and scroll to a place in the document (1-based line and column; `length` characters are selected).
   * Applied each time `nonce` changes — and only once `value` is non-empty, so it is safe to set before the file has loaded.
   */
  reveal?: { line: number; col: number; length: number; nonce: number };
}

/**
 * A code editor whose smarts come from *other plugins* (`oneclient.editors`, see plugin-api/src/file-editor.ts):
 * Format (Shift+Alt+F), breadcrumbs showing the nesting at the cursor, syntax highlighting, a live preview pane and an
 * Actions menu — for whatever file type `fileName` says. It's a plain <textarea> underneath, so it stays light and
 * behaves natively (selection, undo, IME).
 *
 * Fill the available space: wrap it in a flex/grid cell with a definite height. Import `@oneclient/editor-kit/editor.css`.
 * Vite builds must alias `@oneclient/plugin-api` to its source (it ships as CommonJS) — see e.g. packages/plugins/oneclient-postgres/vite.config.ts.
 */
export function FeatureEditor({
  value: text,
  onChange,
  fileName,
  displayPath,
  indentSource,
  readOnly = false,
  toolbarStart,
  toolbarEnd,
  status,
  statusEnd,
  onSave,
  completionProviders = DEFAULT_PROVIDERS,
  reveal,
}: FeatureEditorProps) {
  const [cursor, setCursor] = useState({ line: 1, col: 1, offset: 0 });
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [previewChoice, setPreviewChoice] = useState<boolean | null>(null); // null = follow the file type's default
  const [actionsOpen, setActionsOpen] = useState(false);
  /** Find / Replace widget (Ctrl+F / Ctrl+H); `nonce` re-opens / refocuses it, `step` is F3 / Shift+F3. */
  const [find, setFind] = useState<{ mode: FindMode; nonce: number; step?: 1 | -1 } | null>(null);
  const [findMarks, setFindMarks] = useState<{ matches: FindMatch[]; current: number }>({ matches: [], current: -1 });
  const onFindMatches = useCallback((matches: FindMatch[], current: number) => setFindMarks({ matches, current }), []);
  const [goToLine, setGoToLine] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<PreviewHandle>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  useAutocomplete(textareaRef, { providers: completionProviders, minPrefixLength: 2 });

  const features = useFileFeatures(fileName);
  const large = text.length > FEATURE_TEXT_LIMIT;
  const analysis = useAnalysis(text, features, fileName, !large);
  const indent = useMemo(() => detectIndent(indentSource ?? text), [indentSource, text]);
  const showPreview = Boolean(features?.preview) && !large && (previewChoice ?? features?.previewByDefault ?? false);

  // ---- derived editor state -------------------------------------------------------------------

  /** Highlight layer: the latest tokens, shifted across whatever was typed since they were computed. */
  const highlightHtml = useMemo(() => {
    const snap = analysis.tokens;
    if (!snap || large) return null;
    return buildHighlightHtml(text, shiftTokens(snap.tokens, diffEdit(snap.text, text)), snap.classes);
  }, [analysis.tokens, text, large]);

  /** Breadcrumbs: symbols were computed for an older snapshot, so the cursor is mapped back into it. */
  const structure = useMemo(() => {
    const snap = analysis.symbols;
    if (!snap) return null;
    const edit = diffEdit(snap.text, text);
    return { symbols: snap.symbols, path: symbolPath(snap.symbols, mapBack(cursor.offset, edit)), edit, error: snap.error };
  }, [analysis.symbols, text, cursor.offset]);

  const shownProblem: Problem | null =
    problem ??
    (structure?.error ? { message: structure.error.message, offset: structure.error.offset === undefined ? undefined : mapForward(structure.error.offset, structure.edit) } : null);

  // ---- cursor, jumping, replacing -------------------------------------------------------------

  const updateCursor = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    setCursor({ line: lineOf(el.value, el.selectionStart) + 1, col: el.selectionStart - (before.lastIndexOf("\n") + 1) + 1, offset: el.selectionStart });
  }, []);

  // React's onSelect only fires for keys and clicks; the browser's own `select` event also covers selections made any
  // other way (drag, double-click, programmatic), so the breadcrumb path never lags behind the caret.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.addEventListener("select", updateCursor);
    return () => el.removeEventListener("select", updateCursor);
  }, [updateCursor]);

  /** Put the caret at `offset` and scroll it into view (a textarea doesn't do that on setSelectionRange). */
  const jumpTo = useCallback(
    (offset: number) => {
      const el = textareaRef.current;
      if (!el) return;
      const at = Math.max(0, Math.min(offset, el.value.length));
      el.focus();
      el.setSelectionRange(at, at);
      const top = lineOf(el.value, at) * LINE_HEIGHT;
      if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 3 * LINE_HEIGHT) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
      updateCursor();
    },
    [updateCursor],
  );

  // "Reveal": select a match and scroll it into view (e.g. clicking a result in Search).
  const lastReveal = useRef(-1);
  useEffect(() => {
    const el = textareaRef.current;
    if (!reveal || !el || el.value === "" || lastReveal.current === reveal.nonce) return;
    lastReveal.current = reveal.nonce;
    const lines = el.value.split("\n");
    const lineIndex = Math.min(Math.max(reveal.line - 1, 0), lines.length - 1);
    let offset = 0;
    for (let i = 0; i < lineIndex; i++) offset += lines[i]!.length + 1;
    const start = Math.min(offset + Math.max(reveal.col - 1, 0), offset + lines[lineIndex]!.length);
    el.focus();
    el.setSelectionRange(start, Math.min(start + Math.max(reveal.length, 0), el.value.length));
    el.scrollTop = Math.max(0, lineIndex * LINE_HEIGHT - el.clientHeight / 3);
    updateCursor();
  }, [reveal, text, updateCursor]);

  /** Replace the whole document as one undoable edit, keeping the caret and scroll position roughly in place. */
  function replaceDocument(el: HTMLTextAreaElement, next: string) {
    const prev = el.value;
    const caret = el.selectionStart;
    const scrollTop = el.scrollTop;
    el.focus();
    el.select();
    // execCommand keeps this on the native undo stack (Ctrl+Z undoes the format); assigning .value wouldn't.
    document.execCommand("insertText", false, next);
    const pos = caretAfterReplace(prev, caret, next);
    el.setSelectionRange(pos, pos);
    el.scrollTop = scrollTop;
    updateCursor();
  }

  /** Run a transform command (Format, or an action from any plugin) on the document or the selection. */
  const runTransform = useCallback(
    async (command: string, label: string) => {
      const el = textareaRef.current;
      if (!el || busy || readOnly) return;
      const before = el.value;
      const request: TransformRequest = {
        text: before,
        fileName,
        tabSize: indent === "\t" ? 4 : indent.length,
        insertSpaces: indent !== "\t",
        ...(el.selectionEnd > el.selectionStart ? { selection: { start: el.selectionStart, end: el.selectionEnd } } : {}),
      };
      setBusy(label);
      const r = await callFeature<TransformResult>(command, request);
      setBusy(null);
      if (!r.ok || !("text" in r)) {
        const error = !r.ok ? r.error : { message: "The command returned nothing." };
        setProblem({ message: error.message, offset: error.offset });
        return;
      }
      if (el.value !== before) {
        setProblem({ message: `${label} was skipped because the document changed meanwhile — run it again.` });
        return;
      }
      setProblem(null);
      if (r.text === before) {
        flash(setNotice, `${label}: no changes`);
        return;
      }
      replaceDocument(el, r.text);
      flash(setNotice, label === "Format" ? "Formatted" : label);
    },
    // replaceDocument only touches refs and stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, indent, readOnly, fileName],
  );

  // ---- keyboard -------------------------------------------------------------------------------

  const format = features?.format;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "s" && onSave) {
        e.preventDefault();
        onSave();
      } else if (mod && !e.shiftKey && !e.altKey && (key === "f" || key === "h")) {
        e.preventDefault();
        setGoToLine(false);
        setFind((f) => ({ mode: key === "h" && !readOnly ? "replace" : "find", nonce: (f?.nonce ?? 0) + 1 }));
      } else if (mod && !e.shiftKey && !e.altKey && key === "g") {
        e.preventDefault();
        setFind(null);
        setGoToLine(true);
      } else if (e.key === "F3" && !mod) {
        e.preventDefault();
        setFind((f) => ({ mode: f?.mode ?? "find", nonce: (f?.nonce ?? 0) + 1, ...(f ? { step: e.shiftKey ? -1 : 1 } : {}) }));
      } else if (e.key === "Escape" && document.activeElement === textareaRef.current && (find || goToLine)) {
        setFind(null);
        setGoToLine(false);
      } else if (e.shiftKey && e.altKey && e.key.toLowerCase() === "f" && format) {
        e.preventDefault();
        void runTransform(format, "Format");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSave, format, runTransform, readOnly, find, goToLine]);

  useEffect(() => {
    if (!actionsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!actionsRef.current?.contains(e.target as Node)) setActionsOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [actionsOpen]);

  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && !readOnly) {
      e.preventDefault();
      // execCommand keeps the edit on the textarea's native undo stack, unlike setting .value.
      if (!e.shiftKey) document.execCommand("insertText", false, indent);
    }
  }

  function goToSymbol(symbol: DocumentSymbol) {
    jumpTo(structure ? mapForward(symbol.start, structure.edit) : symbol.start);
  }

  // ---- render ---------------------------------------------------------------------------------

  const actions = features?.actions ?? [];
  return (
    <div className="oce-editor">
      <div className="oce-toolbar">
        {toolbarStart ?? <span className="oce-file-name">{fileName}</span>}
        <span className="oce-spacer" />
        {features?.format && !readOnly && (
          <button className="oce-icon-btn" disabled={busy !== null} onClick={() => void runTransform(features.format!, "Format")} title={busy === "Format" ? "Formatting…" : "Format Document (Shift+Alt+F)"} aria-label="Format Document">
            <Icon id={busy === "Format" ? "refresh" : "format"} size={15} />
          </button>
        )}
        {actions.length > 0 && !readOnly && (
          <div className="oce-menu-anchor" ref={actionsRef}>
            <button className={`oce-icon-btn ${actionsOpen ? "on" : ""}`} onClick={() => setActionsOpen((v) => !v)} aria-haspopup="menu" aria-expanded={actionsOpen} title="Actions" aria-label="Actions">
              <Icon id="ellipsis" size={15} />
            </button>
            {actionsOpen && (
              <div className="oce-menu" role="menu">
                {actions.map((a: FileEditorAction & { pluginId: string }) => (
                  <div
                    key={`${a.pluginId}:${a.id}`}
                    role="menuitem"
                    className="oce-menu-item"
                    title={a.title ?? a.pluginId}
                    onClick={() => {
                      setActionsOpen(false);
                      void runTransform(a.command, a.label);
                    }}
                  >
                    {a.label}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {features?.preview && !large && (
          <button className={`oce-icon-btn ${showPreview ? "on" : ""}`} onClick={() => setPreviewChoice(!showPreview)} title={showPreview ? "Hide preview" : "Show preview"} aria-label="Toggle preview" aria-pressed={showPreview}>
            <Icon id="preview" size={15} />
          </button>
        )}
        {toolbarEnd}
      </div>

      <Breadcrumbs filePath={displayPath ?? fileName} path={structure?.path ?? []} symbols={structure?.symbols ?? []} onGoTo={goToSymbol} />

      <div className={`oce-body ${showPreview ? "split" : ""}`}>
        <div className="oce-pane-editor">
          {find && (
            <FindWidget
              textareaRef={textareaRef}
              text={text}
              readOnly={readOnly}
              request={find}
              geometry={GEOMETRY}
              onMatches={onFindMatches}
              onReplaceAll={(next) => {
                const el = textareaRef.current;
                if (el) replaceDocument(el, next);
              }}
              onSelect={updateCursor}
              onClose={() => setFind(null)}
            />
          )}
          {goToLine && (
            <GoToLine
              lineCount={text.split("\n").length}
              onClose={() => {
                setGoToLine(false);
                textareaRef.current?.focus();
              }}
              onGo={(line, col) => {
                setGoToLine(false);
                const lines = text.split("\n");
                let offset = 0;
                for (let i = 0; i < line - 1; i++) offset += lines[i]!.length + 1;
                jumpTo(offset + Math.min(Math.max(col - 1, 0), lines[line - 1]?.length ?? 0));
              }}
            />
          )}
          <EditorSurface
            underlay={find ? <FindMarks textareaRef={textareaRef} text={text} matches={findMarks.matches} current={findMarks.current} geometry={GEOMETRY} /> : null}
            text={text}
            textareaRef={textareaRef}
            highlightHtml={highlightHtml}
            cursorLine={cursor.line}
            readOnly={readOnly}
            onChange={(v) => {
              onChange(v);
              setProblem(null);
            }}
            onKeyDown={onTextareaKeyDown}
            onCursor={updateCursor}
            onScrollFraction={showPreview ? (f) => previewRef.current?.scrollToFraction(f) : undefined}
          />
        </div>
        {showPreview && features?.preview && (
          <div className="oce-pane-preview">
            <PreviewPane ref={previewRef} text={text} command={features.preview} fileName={fileName} />
          </div>
        )}
      </div>

      <div className="oce-statusbar">
        {shownProblem ? (
          <button className="oce-problem" onClick={() => shownProblem.offset !== undefined && jumpTo(shownProblem.offset)} title={shownProblem.offset !== undefined ? "Go to problem" : undefined}>
            ⚠ {shownProblem.message}
            {shownProblem.offset !== undefined && ` (Ln ${lineOf(text, shownProblem.offset) + 1})`}
          </button>
        ) : status ? (
          status
        ) : notice ? (
          <span>{notice}</span>
        ) : large ? (
          <span>Large file — syntax features are off</span>
        ) : null}
        <span className="oce-spacer" />
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <span>{indent === "\t" ? "Tabs" : `Spaces: ${indent.length}`}</span>
        {statusEnd}
        <span>{features?.label ?? "Plain Text"}</span>
      </div>
    </div>
  );
}

/** Show a status-bar message for a couple of seconds. */
function flash(set: (v: string | null) => void, message: string) {
  set(message);
  setTimeout(() => set(null), 2500);
}

/** Tabs if most indented lines start with one, else the smallest common space indent (default 2). */
export function detectIndent(s: string): string {
  let tabs = 0;
  let spaces = 0;
  let minSpaces = Infinity;
  for (const line of s.split("\n")) {
    if (line.startsWith("\t")) tabs++;
    else {
      const m = /^( +)\S/.exec(line);
      if (m?.[1]) {
        spaces++;
        minSpaces = Math.min(minSpaces, m[1].length);
      }
    }
  }
  if (tabs > spaces) return "\t";
  return " ".repeat(spaces > 0 && minSpaces <= 8 ? minSpaces : 2);
}
