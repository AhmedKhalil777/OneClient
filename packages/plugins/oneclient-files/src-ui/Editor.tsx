import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSymbol, FileEditorAction, TransformRequest, TransformResult } from "@oneclient/plugin-api";
import { wordsProvider } from "@oneclient/editor-kit";
import { Icon, useAutocomplete } from "@oneclient/editor-kit/react";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { EditorSurface } from "./EditorSurface.js";
import { type PreviewHandle, PreviewPane } from "./PreviewPane.js";
import { callFeature, fileName, filePath, readFile, writeFile } from "./api.js";
import { FEATURE_TEXT_LIMIT, useAnalysis, useFileFeatures } from "./features.js";
import { caretAfterReplace, diffEdit, lineOf, mapBack, mapForward, shiftTokens } from "./lib/edit.js";
import { buildHighlightHtml } from "./lib/highlight.js";
import { symbolPath } from "./lib/symbols.js";

/** Plain files have no language service yet, so suggest words already in the file (VS Code's default). */
const COMPLETION_PROVIDERS = [wordsProvider()];
const LINE_HEIGHT = 20;

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; eol: "\n" | "\r\n"; bom: boolean };

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: Date } | { kind: "error"; message: string };

interface Problem {
  message: string;
  /** Offset into the *current* text to jump to. */
  offset?: number | undefined;
}

/**
 * Editor for one file. A <textarea> keeps it dependency-free; line endings are normalized to "\n" (the file's
 * EOL and UTF-8 BOM are remembered and restored on save).
 *
 * What it knows about each file type comes from other plugins (`oneclient-files.editors`, see
 * plugin-api/src/file-editor.ts): a formatter, breadcrumbs, syntax highlighting, a preview and extra actions.
 */
export function Editor() {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [cursor, setCursor] = useState({ line: 1, col: 1, offset: 0 });
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [previewChoice, setPreviewChoice] = useState<boolean | null>(null); // null = follow the file type's default
  const [actionsOpen, setActionsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<PreviewHandle>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  useAutocomplete(textareaRef, { providers: COMPLETION_PROVIDERS, minPrefixLength: 2 });

  const features = useFileFeatures(fileName);
  const large = text.length > FEATURE_TEXT_LIMIT;
  const analysis = useAnalysis(text, features, fileName, load.kind === "ready" && !large);

  const dirty = load.kind === "ready" && text !== savedText;
  const indent = useMemo(() => detectIndent(savedText), [savedText]);
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

  // ---- loading & saving -----------------------------------------------------------------------

  const reload = useCallback(async () => {
    setLoad({ kind: "loading" });
    const result = await readFile().catch((err: unknown) => ({ ok: false as const, error: String(err) }));
    if (!result.ok) {
      setLoad({ kind: "error", message: result.error });
      return;
    }
    const normalized = result.content.replace(/\r\n/g, "\n");
    setText(normalized);
    setSavedText(normalized);
    setSave({ kind: "idle" });
    setProblem(null);
    setLoad({ kind: "ready", eol: result.eol, bom: result.bom });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const doSave = useCallback(async () => {
    if (load.kind !== "ready") return;
    const snapshot = text;
    setSave({ kind: "saving" });
    const onDisk = (load.bom ? "\uFEFF" : "") + (load.eol === "\r\n" ? snapshot.replace(/\n/g, "\r\n") : snapshot);
    const result = await writeFile(onDisk).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
    if (result.ok) {
      setSavedText(snapshot);
      setSave({ kind: "saved", at: new Date() });
    } else {
      setSave({ kind: "error", message: result.error });
    }
  }, [load, text]);

  useEffect(() => {
    window.oneclientView.setDirty(dirty);
  }, [dirty]);

  // ---- cursor, jumping, replacing -------------------------------------------------------------

  const updateCursor = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const line = lineOf(el.value, el.selectionStart) + 1;
    setCursor({ line, col: el.selectionStart - (before.lastIndexOf("\n") + 1) + 1, offset: el.selectionStart });
  }, []);

  // React's onSelect only fires for keys and clicks; the browser's own `select` event also covers selections made any
  // other way (drag, double-click, programmatic), so the breadcrumb path never lags behind the caret.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.addEventListener("select", updateCursor);
    return () => el.removeEventListener("select", updateCursor);
  }, [updateCursor, load.kind]);

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
      if (!el || busy) return;
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
    [busy, indent],
  );

  // ---- keyboard -------------------------------------------------------------------------------

  const format = features?.format;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSave();
      } else if (e.shiftKey && e.altKey && e.key.toLowerCase() === "f" && format) {
        e.preventDefault();
        void runTransform(format, "Format");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [doSave, format, runTransform]);

  useEffect(() => {
    if (!actionsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!actionsRef.current?.contains(e.target as Node)) setActionsOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [actionsOpen]);

  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      // execCommand keeps the edit on the textarea's native undo stack, unlike setting .value.
      if (!e.shiftKey) document.execCommand("insertText", false, indent);
    }
  }

  function goToSymbol(symbol: DocumentSymbol) {
    jumpTo(structure ? mapForward(symbol.start, structure.edit) : symbol.start);
  }

  // ---- render ---------------------------------------------------------------------------------

  if (load.kind === "loading") return <div className="message">Loading {filePath}…</div>;
  if (load.kind === "error") {
    return (
      <div className="message">
        <div className="error">{load.message}</div>
        <button className="btn" onClick={() => void reload()}>
          Retry
        </button>
      </div>
    );
  }

  const actions = features?.actions ?? [];
  return (
    <div className="editor">
      <div className="toolbar">
        <span className="file-name" title={filePath}>
          {fileName}
        </span>
        {dirty && (
          <span className="dirty" title="Unsaved changes">
            ●
          </span>
        )}
        <span className="spacer" />
        {features?.format && (
          <button className="btn" disabled={busy !== null} onClick={() => void runTransform(features.format!, "Format")} title="Format Document (Shift+Alt+F)">
            {busy === "Format" ? "Formatting…" : "Format"}
          </button>
        )}
        {actions.length > 0 && (
          <div className="menu-anchor" ref={actionsRef}>
            <button className="btn" onClick={() => setActionsOpen((v) => !v)} aria-haspopup="menu" aria-expanded={actionsOpen}>
              Actions <Icon id="chevron-down" size={12} />
            </button>
            {actionsOpen && (
              <div className="menu" role="menu">
                {actions.map((a: FileEditorAction & { pluginId: string }) => (
                  <div
                    key={`${a.pluginId}:${a.id}`}
                    role="menuitem"
                    className="menu-item"
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
          <button className={`btn ${showPreview ? "btn-on" : ""}`} onClick={() => setPreviewChoice(!showPreview)} title="Toggle preview" aria-pressed={showPreview}>
            <Icon id="preview" size={14} /> Preview
          </button>
        )}
        <button className="btn" disabled={!dirty || save.kind === "saving"} onClick={() => void reload()} title="Discard changes and reload from disk">
          Revert
        </button>
        <button className="btn btn-primary" disabled={!dirty || save.kind === "saving"} onClick={() => void doSave()} title="Save (Ctrl+S)">
          {save.kind === "saving" ? "Saving…" : "Save"}
        </button>
      </div>

      <Breadcrumbs filePath={filePath} path={structure?.path ?? []} symbols={structure?.symbols ?? []} onGoTo={goToSymbol} />

      <div className={`body ${showPreview ? "split" : ""}`}>
        <div className="pane-editor">
          <EditorSurface
            text={text}
            textareaRef={textareaRef}
            highlightHtml={highlightHtml}
            cursorLine={cursor.line}
            onChange={(value) => {
              setText(value);
              setProblem(null);
              if (save.kind === "saved" || save.kind === "error") setSave({ kind: "idle" });
            }}
            onKeyDown={onTextareaKeyDown}
            onCursor={updateCursor}
            onScrollFraction={showPreview ? (f) => previewRef.current?.scrollToFraction(f) : undefined}
          />
        </div>
        {showPreview && features?.preview && (
          <div className="pane-preview">
            <PreviewPane ref={previewRef} text={text} command={features.preview} fileName={fileName} />
          </div>
        )}
      </div>

      <div className="statusbar">
        {shownProblem ? (
          <button className="problem" onClick={() => shownProblem.offset !== undefined && jumpTo(shownProblem.offset)} title={shownProblem.offset !== undefined ? "Go to problem" : undefined}>
            ⚠ {shownProblem.message}
            {shownProblem.offset !== undefined && ` (Ln ${lineOf(text, shownProblem.offset) + 1})`}
          </button>
        ) : save.kind === "error" ? (
          <span className="error">Save failed: {save.message}</span>
        ) : save.kind === "saved" ? (
          <span>Saved {save.at.toLocaleTimeString()}</span>
        ) : notice ? (
          <span>{notice}</span>
        ) : large ? (
          <span>Large file — syntax features are off</span>
        ) : null}
        <span className="spacer" />
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <span>{indent === "\t" ? "Tabs" : `Spaces: ${indent.length}`}</span>
        <span>UTF-8{load.bom ? " with BOM" : ""}</span>
        <span>{load.eol === "\r\n" ? "CRLF" : "LF"}</span>
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
function detectIndent(s: string): string {
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
