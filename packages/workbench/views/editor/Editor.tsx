import { useCallback, useEffect, useState } from "react";
import { FeatureEditor } from "@oneclient/editor-kit/editor";
import { Icon } from "@oneclient/editor-kit/react";
import { fileName, filePath, isImage, readFile, writeFile } from "./api.js";
import { ImageViewer } from "./ImageViewer.js";

interface RevealMessage {
  type: "reveal";
  path: string;
  line: number;
  col: number;
  length: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; eol: "\n" | "\r\n"; bom: boolean };

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: Date } | { kind: "error"; message: string };

/**
 * Editor for one file: loads it, saves it, and remembers its line endings and UTF-8 BOM (the text is edited with
 * "\n" and converted back on save). Everything language-specific — format, breadcrumbs, highlighting, preview,
 * actions — comes from other plugins through the shared <FeatureEditor> (`oneclient.editors`, see
 * plugin-api/src/file-editor.ts).
 */
/** Images get a viewer; everything else the text editor. */
export function Editor() {
  return isImage ? <ImageViewer /> : <TextEditor />;
}

function TextEditor() {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  // "Reveal this match" requests from the Search view (they reach every editor tab, so check the path).
  const [reveal, setReveal] = useState<{ line: number; col: number; length: number; nonce: number } | undefined>();
  const ready = load.kind === "ready";
  useEffect(() => {
    if (!ready) return;
    const off = window.oneclientView.onMessage((raw) => {
      const m = raw as RevealMessage;
      if (m?.type === "reveal" && m.path === filePath) setReveal({ line: m.line, col: m.col, length: m.length, nonce: Date.now() });
    });
    window.oneclientView.postMessage({ type: "hello", path: filePath });
    return off;
  }, [ready]);

  const dirty = load.kind === "ready" && text !== savedText;

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

  useEffect(() => {
    window.oneclientView.setDirty(dirty);
  }, [dirty]);

  if (load.kind === "loading") return <div className="message">Loading {filePath}…</div>;
  if (load.kind === "error") {
    return (
      <div className="message">
        <div className="error">{load.message}</div>
        <button className="oce-btn" onClick={() => void reload()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <FeatureEditor
      value={text}
      {...(reveal ? { reveal } : {})}
      onChange={(value) => {
        setText(value);
        if (save.kind === "saved" || save.kind === "error") setSave({ kind: "idle" });
      }}
      fileName={fileName}
      displayPath={filePath}
      indentSource={savedText}
      onSave={() => void doSave()}
      toolbarStart={
        <>
          <span className="oce-file-name" title={filePath}>
            {fileName}
          </span>
          {dirty && (
            <span className="oce-dirty" title="Unsaved changes">
              ●
            </span>
          )}
        </>
      }
      toolbarEnd={
        <>
          <button className="oce-icon-btn" disabled={!dirty || save.kind === "saving"} onClick={() => void reload()} title="Revert — discard changes and reload from disk" aria-label="Revert">
            <Icon id="discard" size={15} />
          </button>
          <button className={`oce-icon-btn ${dirty ? "primary" : ""}`} disabled={!dirty || save.kind === "saving"} onClick={() => void doSave()} title={save.kind === "saving" ? "Saving…" : "Save (Ctrl+S)"} aria-label="Save">
            <Icon id={save.kind === "saving" ? "refresh" : "save"} size={15} />
          </button>
        </>
      }
      status={
        save.kind === "error" ? (
          <span className="oce-error">Save failed: {save.message}</span>
        ) : save.kind === "saved" ? (
          <span>Saved {save.at.toLocaleTimeString()}</span>
        ) : null
      }
      statusEnd={
        <>
          <span>UTF-8{load.bom ? " with BOM" : ""}</span>
          <span>{load.eol === "\r\n" ? "CRLF" : "LF"}</span>
        </>
      }
    />
  );
}
