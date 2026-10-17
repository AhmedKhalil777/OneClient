import { useCallback, useEffect, useState } from "react";
import { FeatureEditor } from "@oneclient/editor-kit/editor";
import { fileName, filePath, readFile, writeFile } from "./api.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; eol: "\n" | "\r\n"; bom: boolean };

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: Date } | { kind: "error"; message: string };

/**
 * Editor for one file: loads it, saves it, and remembers its line endings and UTF-8 BOM (the text is edited with
 * "\n" and converted back on save). Everything language-specific — format, breadcrumbs, highlighting, preview,
 * actions — comes from other plugins through the shared <FeatureEditor> (`oneclient-files.editors`, see
 * plugin-api/src/file-editor.ts).
 */
export function Editor() {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

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
          <button className="oce-btn" disabled={!dirty || save.kind === "saving"} onClick={() => void reload()} title="Discard changes and reload from disk">
            Revert
          </button>
          <button className="oce-btn oce-btn-primary" disabled={!dirty || save.kind === "saving"} onClick={() => void doSave()} title="Save (Ctrl+S)">
            {save.kind === "saving" ? "Saving…" : "Save"}
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
