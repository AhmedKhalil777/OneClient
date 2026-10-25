import { useEffect, useRef, useState } from "react";
import { useTheme } from "../react.js";
import { themeCssText } from "../theme.js";
import { PREVIEW_SHELL } from "./previewDocument.js";

export interface RunOutcome {
  title: string;
  /** Null while the run is in flight. */
  html: string | null;
  css: string;
  error?: string | undefined;
}

/**
 * The result of running something in the document (a lens's command — e.g. an HTTP request): HTML in the same
 * script-less sandboxed frame the preview uses, under a small header with a close button.
 */
export function ResultPane({ outcome, onClose }: { outcome: RunOutcome; onClose: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const theme = useTheme();

  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!ready || !doc) return;
    const style = doc.getElementById("oc-theme");
    if (style) style.textContent = themeCssText(theme);
  }, [ready, theme]);

  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!ready || !doc) return;
    const content = doc.getElementById("content");
    const pluginStyle = doc.getElementById("oc-plugin");
    if (content) content.innerHTML = outcome.html ?? "";
    if (pluginStyle) pluginStyle.textContent = outcome.css;
    doc.defaultView?.scrollTo(0, 0);
  }, [ready, outcome.html, outcome.css]);

  function onLoad() {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    doc.addEventListener("click", (e) => {
      const anchor = (e.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      e.preventDefault();
      const href = anchor.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href)) window.oneclientView.openExternal(href);
    });
    setReady(true);
  }

  return (
    <div className="oce-result-pane">
      <div className="oce-result-head">
        <span className="oce-result-title" title={outcome.title}>{outcome.title}</span>
        {outcome.html === null && !outcome.error && <span className="oce-result-busy">Running…</span>}
        <span className="oce-spacer" />
        <button className="oce-icon-btn" onClick={onClose} title="Close result" aria-label="Close result">✕</button>
      </div>
      {outcome.error && <div className="oce-preview-error">{outcome.error}</div>}
      <iframe ref={frameRef} title="Result" sandbox="allow-same-origin" srcDoc={PREVIEW_SHELL} onLoad={onLoad} />
    </div>
  );
}
