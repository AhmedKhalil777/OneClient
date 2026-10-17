import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filePath, readFile, writeFile } from "./api.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; eol: "\n" | "\r\n"; bom: boolean };

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: Date } | { kind: "error"; message: string };

/**
 * Plain-text editor for one file. A <textarea> keeps this dependency-free;
 * it normalizes line endings to "\n", so the file's original EOL (and
 * UTF-8 BOM) are remembered on load and restored on save.
 */
export function Editor() {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const dirty = load.kind === "ready" && text !== savedText;
  const indent = useMemo(() => detectIndent(savedText), [savedText]);
  const lineCount = useMemo(() => countLines(text), [text]);

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
    setLoad({ kind: "ready", eol: result.eol, bom: result.bom });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const doSave = useCallback(async () => {
    if (load.kind !== "ready") return;
    const snapshot = text;
    setSave({ kind: "saving" });
    const onDisk = (load.bom ? "﻿" : "") + (load.eol === "\r\n" ? snapshot.replace(/\n/g, "\r\n") : snapshot);
    const result = await writeFile(onDisk).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
    if (result.ok) {
      setSavedText(snapshot);
      setSave({ kind: "saved", at: new Date() });
    } else {
      setSave({ kind: "error", message: result.error });
    }
  }, [load, text]);

  // Ctrl/Cmd+S anywhere in the view. Keystrokes go to this WebContentsView, not the app shell.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSave();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [doSave]);

  useEffect(() => {
    window.oneclientView.setDirty(dirty);
  }, [dirty]);

  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      // execCommand keeps the edit on the textarea's native undo stack, unlike setting .value.
      if (!e.shiftKey) document.execCommand("insertText", false, indent);
    }
  }

  function updateCursor() {
    const el = textareaRef.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const line = countLines(before);
    const col = el.selectionStart - (before.lastIndexOf("\n") + 1) + 1;
    setCursor({ line, col });
  }

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

  return (
    <div className="editor">
      <div className="toolbar">
        <span className="path" title={filePath}>
          {filePath.split("/").map((part, i, all) => (
            <span key={i}>
              {part}
              {i < all.length - 1 && <span className="sep">›</span>}
            </span>
          ))}
        </span>
        {dirty && <span className="dirty" title="Unsaved changes">●</span>}
        <span className="spacer" />
        <button className="btn" disabled={!dirty || save.kind === "saving"} onClick={() => void reload()} title="Discard changes and reload from disk">
          Revert
        </button>
        <button className="btn btn-primary" disabled={!dirty || save.kind === "saving"} onClick={() => void doSave()} title="Save (Ctrl+S)">
          {save.kind === "saving" ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="body">
        <div className="gutter" ref={gutterRef} aria-hidden>
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className={i + 1 === cursor.line ? "current" : undefined}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          value={text}
          spellCheck={false}
          autoFocus
          wrap="off"
          onChange={(e) => {
            setText(e.target.value);
            if (save.kind === "saved" || save.kind === "error") setSave({ kind: "idle" });
          }}
          onKeyDown={onTextareaKeyDown}
          onKeyUp={updateCursor}
          onClick={updateCursor}
          onSelect={updateCursor}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>

      <div className="statusbar">
        {save.kind === "error" && <span className="error">Save failed: {save.message}</span>}
        {save.kind === "saved" && <span>Saved {save.at.toLocaleTimeString()}</span>}
        <span className="spacer" />
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <span>{indent === "\t" ? "Tabs" : `Spaces: ${indent.length}`}</span>
        <span>UTF-8{load.bom ? " with BOM" : ""}</span>
        <span>{load.eol === "\r\n" ? "CRLF" : "LF"}</span>
      </div>
    </div>
  );
}

function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
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
