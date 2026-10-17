import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FileEditorError, PreviewResult } from "@oneclient/plugin-api";
import { useTheme } from "../react.js";
import { themeCssText } from "../theme.js";
import { callFeature } from "./features.js";
import { PREVIEW_SHELL } from "./previewDocument.js";

export interface PreviewHandle {
  /** Scroll the preview to the same relative position as the editor (0 = top, 1 = bottom). */
  scrollToFraction(fraction: number): void;
}

const DEBOUNCE_MS = 200;

/**
 * Renders another plugin's `preview` command output (HTML) in a script-less sandboxed frame, next to the
 * source. Re-renders shortly after typing stops, updating in place so the scroll position survives.
 */
export const PreviewPane = forwardRef<PreviewHandle, { text: string; command: string; fileName: string }>(function PreviewPane(
  { text, command, fileName },
  ref,
) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<{ html: string; css: string } | null>(null);
  const [error, setError] = useState<FileEditorError | null>(null);
  const requestId = useRef(0);
  const theme = useTheme();

  useImperativeHandle(ref, () => ({
    scrollToFraction(fraction) {
      const win = frameRef.current?.contentWindow;
      const doc = win?.document.documentElement;
      if (win && doc) win.scrollTo(0, Math.max(0, fraction) * Math.max(0, doc.scrollHeight - win.innerHeight));
    },
  }));

  // Ask the plugin for fresh HTML a moment after typing stops (immediately for the first render).
  useEffect(() => {
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      const r = await callFeature<PreviewResult>(command, { text, fileName });
      if (id !== requestId.current) return;
      if (r.ok && "html" in r) {
        setResult({ html: r.html, css: r.css ?? "" });
        setError(null);
      } else if (!r.ok) {
        setError(r.error);
      }
    }, result ? DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
    // `result` is read only to skip the debounce for the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, command, fileName]);

  // The frame's document is same-origin (allow-same-origin) but script-less, so we can write into it directly.
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!ready || !doc) return;
    const style = doc.getElementById("oc-theme");
    if (style) style.textContent = themeCssText(theme);
  }, [ready, theme]);

  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!ready || !doc || !result) return;
    const content = doc.getElementById("content");
    const pluginStyle = doc.getElementById("oc-plugin");
    if (content) content.innerHTML = result.html;
    if (pluginStyle) pluginStyle.textContent = result.css;
  }, [ready, result]);

  function onLoad() {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    // Links never navigate the frame: "#section" scrolls inside it, web/mail links go to the user's browser.
    doc.addEventListener("click", (e) => {
      const anchor = (e.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      e.preventDefault();
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        let id = href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          /* keep raw */
        }
        doc.getElementById(id)?.scrollIntoView();
      } else if (/^(https?:|mailto:)/i.test(href)) {
        window.oneclientView.openExternal(href);
      }
    });
    setReady(true);
  }

  return (
    <div className="oce-preview-pane">
      {error && <div className="oce-preview-error">Preview unavailable: {error.message}</div>}
      <iframe ref={frameRef} title="Preview" sandbox="allow-same-origin" srcDoc={PREVIEW_SHELL} onLoad={onLoad} />
    </div>
  );
});
