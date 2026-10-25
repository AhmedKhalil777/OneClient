import { type ReactNode, useState } from "react";
import { MermaidBlock } from "./Mermaid.js";
import { type Block, parseMarkdown } from "./md-parse.js";

/**
 * Renders a chat reply: GitHub-flavoured Markdown (tables, task lists, quotes, nested lists, strikethrough, links,
 * code with a copy button) plus ```mermaid diagrams. It builds React nodes — never HTML strings — so nothing a model
 * writes can inject markup.
 */

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ai-code">
      <div className="ai-code-head">
        <span>{lang || "text"}</span>
        <button
          className="ai-link"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|\*([^*\s][^*\n]*?)\*|(?<![\w])_([^_\s][^_\n]*?)_(?![\w])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<)\]]+[^\s<)\].,;:!?])/g;

function openLink(e: React.MouseEvent, href: string) {
  e.preventDefault();
  window.oneclientView.openExternal(href);
}

/** Inline Markdown → nodes. Emphasis nests (`**bold *and italic***`); a single newline is a line break, like chat apps. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  lines.forEach((line, li) => {
    if (li) out.push(<br key={`${keyBase}-br${li}`} />);
    let last = 0;
    let n = 0;
    for (const m of line.matchAll(INLINE)) {
      const at = m.index ?? 0;
      if (at > last) out.push(line.slice(last, at));
      const key = `${keyBase}-${li}-${n++}`;
      if (m[2] !== undefined) out.push(<code key={key}>{m[2].trim()}</code>);
      else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={key}>{inline((m[3] ?? m[4])!, key)}</strong>);
      else if (m[5] !== undefined) out.push(<del key={key}>{inline(m[5], key)}</del>);
      else if (m[6] !== undefined || m[7] !== undefined) out.push(<em key={key}>{inline((m[6] ?? m[7])!, key)}</em>);
      else {
        const href = (m[9] ?? m[10] ?? m[11])!;
        out.push(
          <a key={key} href={href} title={href} onClick={(e) => openLink(e, href)}>
            {m[8] !== undefined ? inline(m[8], key) : href}
          </a>,
        );
      }
      last = at + m[0].length;
    }
    if (last < line.length) out.push(line.slice(last));
  });
  return out;
}

function renderBlock(b: Block, key: string): ReactNode {
  switch (b.t) {
    case "p":
      return <p key={key}>{inline(b.text, key)}</p>;
    case "h":
      return (
        <div key={key} className={`ai-h ai-h${Math.min(b.level, 4)}`} role="heading" aria-level={b.level}>
          {inline(b.text, key)}
        </div>
      );
    case "code":
      return b.lang === "mermaid" ? <MermaidBlock key={key} code={b.code} open={b.open} /> : <CodeBlock key={key} lang={b.lang} code={b.code} />;
    case "quote":
      return <blockquote key={key}>{b.children.map((c, i) => renderBlock(c, `${key}q${i}`))}</blockquote>;
    case "hr":
      return <hr key={key} />;
    case "list": {
      const items = b.items.map((it, i) => (
        <li key={i} className={it.checked !== null ? "ai-task" : undefined}>
          {it.checked !== null && <input type="checkbox" checked={it.checked} readOnly />}
          {it.children.map((c, j) => (c.t === "p" && j === 0 ? <span key={j}>{inline(c.text, `${key}i${i}`)}</span> : renderBlock(c, `${key}i${i}-${j}`)))}
        </li>
      ));
      return b.ordered ? (
        <ol key={key} start={b.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table":
      return (
        <div key={key} className="ai-table-wrap">
          <table className="ai-table">
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} style={{ textAlign: b.align[i] ?? undefined }}>
                    {inline(h, `${key}h${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={{ textAlign: b.align[ci] ?? undefined }}>
                      {inline(c, `${key}r${ri}c${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  return <>{parseMarkdown(text).map((b, i) => renderBlock(b, `b${i}`))}</>;
}
