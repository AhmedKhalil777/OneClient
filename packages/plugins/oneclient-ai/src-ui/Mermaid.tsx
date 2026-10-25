import { useEffect, useState } from "react";
import { Icon, copyText } from "./icons.js";

/**
 * A ```mermaid block drawn as a diagram (flowcharts, sequence, ER, class, state, gantt…) with a Source tab, copy and
 * SVG download. The library is loaded on first use — it is large and most chats never need it.
 */

type MermaidApi = typeof import("mermaid").default;
let loading: Promise<MermaidApi> | undefined;
let configuredFor: "dark" | "default" | undefined;
let counter = 0;
const cache = new Map<string, string>();

const isDark = () => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
  return m ? 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]) < 140 : true;
};

async function load(): Promise<MermaidApi> {
  loading ??= import("mermaid").then((m) => m.default);
  const mermaid = await loading;
  const theme = isDark() ? "dark" : "default";
  if (configuredFor !== theme) {
    // "strict" keeps scripts and HTML in labels out of the SVG.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: "inherit" });
    configuredFor = theme;
  }
  return mermaid;
}

export function MermaidBlock({ code, open }: { code: string; open: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"diagram" | "source">("diagram");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // While the reply is still streaming the diagram is incomplete: wait for the closing fence.
    if (open || !code.trim()) return;
    const key = `${isDark()}\u0000${code}`;
    const hit = cache.get(key);
    if (hit) {
      setSvg(hit);
      setError(null);
      return;
    }
    let live = true;
    const id = `ai-mmd-${counter++}`;
    void load()
      .then((mermaid) => mermaid.render(id, code.trim()))
      .then((r) => {
        if (!live) return;
        cache.set(key, r.svg);
        setSvg(r.svg);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message.split("\n")[0]! : String(err));
        // mermaid leaves its error graphic in the page when a render fails
        document.getElementById(`d${id}`)?.remove();
        document.getElementById(id)?.remove();
      });
    return () => {
      live = false;
    };
  }, [code, open]);

  const download = () => {
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "diagram.svg";
    a.click();
    URL.revokeObjectURL(url);
  };

  const showSource = tab === "source" || open || error !== null;
  return (
    <div className="ai-mermaid">
      <div className="ai-code-head">
        <span className="ai-mermaid-tabs">
          <button className={!showSource ? "on" : ""} disabled={open || error !== null} onClick={() => setTab("diagram")}>Diagram</button>
          <button className={showSource ? "on" : ""} onClick={() => setTab("source")}>Source</button>
        </span>
        <span className="ai-spacer" />
        {svg && !open && <button className="ai-link" onClick={download} title="Download as SVG"><Icon name="download" size={12} /></button>}
        <button className="ai-link" onClick={() => void copyText(code).then(() => (setCopied(true), window.setTimeout(() => setCopied(false), 1200)))}>{copied ? "Copied" : "Copy"}</button>
      </div>
      {showSource ? (
        <>
          <pre className="ai-mermaid-src"><code>{code}</code></pre>
          {open && <div className="ai-mermaid-note">Drawing the diagram when the reply is complete…</div>}
          {error && <div className="ai-mermaid-note err">Could not draw this diagram: {error}</div>}
        </>
      ) : svg ? (
        <div className="ai-mermaid-view" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="ai-mermaid-note">Drawing…</div>
      )}
    </div>
  );
}
