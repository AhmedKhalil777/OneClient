import type { ReactNode } from "react";

/**
 * A Markdown renderer for plugin READMEs (GitHub flavour): headings, paragraphs, nested and task lists, block quotes,
 * fenced code, tables, rules, images, and inline code / bold / italic / strikethrough / links. It builds React elements
 * (never raw HTML — HTML comments and tag-only lines are dropped), only http(s) and mailto links are clickable, and
 * only images from GitHub's own hosts are shown (what the app's CSP allows).
 *
 * `baseUrl` is the README's page on GitHub: relative links and images are resolved against it, so
 * `docs/guide.md` and `images/shot.png` keep working when the file is shown outside GitHub.
 */
export function Markdown({ source, baseUrl }: { source: string; baseUrl?: string | undefined }) {
  const text = source.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  return <div className="md">{blocks(text.split("\n"), { baseUrl })}</div>;
}

interface Ctx {
  baseUrl: string | undefined;
}

const IMAGE_HOSTS = /^https:\/\/(raw\.githubusercontent\.com|github\.com|user-images\.githubusercontent\.com|avatars\.githubusercontent\.com|camo\.githubusercontent\.com|private-user-images\.githubusercontent\.com|img\.shields\.io)\//i;

/** Resolves a README link / image target; `image` targets of a github.com blob page become its raw file. */
function resolve(href: string, ctx: Ctx, image: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(href, ctx.baseUrl ?? "about:blank");
  } catch {
    return undefined;
  }
  if (image && url.hostname === "github.com" && url.pathname.includes("/blob/")) url.searchParams.set("raw", "true");
  return url.protocol === "http:" || url.protocol === "https:" || (!image && url.protocol === "mailto:") ? url.href : undefined;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(~~[^~]+~~)|(!?\[(?:[^\]\[]|\[[^\]]*\])*\]\([^)\s]+(?:\s+"[^"]*")?\))|(\*[^*\s][^*]*\*|\b_[^_\s][^_]*_\b)|(<br\s*\/?>)|(<\/?[a-zA-Z][^>]*>)|(https?:\/\/[^\s<)]+)/;

function inline(text: string, ctx: Ctx, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = key * 1000;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const token = m[0];
    if (m[1]) out.push(<code key={n++}>{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={n++}>{inline(token.slice(2, -2), ctx, n)}</strong>);
    else if (m[3]) out.push(<del key={n++}>{inline(token.slice(2, -2), ctx, n)}</del>);
    else if (m[4]) {
      const parts = /^(!?)\[([\s\S]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(token)!;
      const [, image, label, href] = parts;
      const url = resolve(href!, ctx, Boolean(image));
      if (image) out.push(url && IMAGE_HOSTS.test(url) ? <img key={n++} src={url} alt={label} loading="lazy" referrerPolicy="no-referrer" /> : label);
      else if (url) out.push(<a key={n++} href={url} target="_blank" rel="noreferrer noopener">{inline(label!, ctx, n)}</a>);
      else out.push(...inline(label!, ctx, n));
    } else if (m[5]) out.push(<em key={n++}>{inline(token.slice(1, -1), ctx, n)}</em>);
    else if (m[6]) out.push(<br key={n++} />);
    else if (m[7]) {
      /* an inline HTML tag: dropped, its text stays */
    } else out.push(<a key={n++} href={token} target="_blank" rel="noreferrer noopener">{token}</a>);
    rest = rest.slice(m.index + token.length);
  }
  return out;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const indentOf = (l: string) => l.length - l.trimStart().length;

function blocks(lines: string[], ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Blank lines, and lines that are only an HTML tag (<p align="center">, </div>, <details>…), separate blocks.
    if (!line.trim() || /^\s*<\/?[a-zA-Z][^>]*>\s*$/.test(line)) {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!); i++) code.push(lines[i]!);
      i++;
      out.push(<pre key={k++}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const Tag = `h${heading[1]!.length}` as "h1";
      out.push(<Tag key={k++}>{inline(heading[2]!, ctx)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push(<hr key={k++} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) quote.push(lines[i]!.replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={k++}>{blocks(quote, ctx)}</blockquote>);
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && isTableRow(lines[i]!); i++) rows.push(cells(lines[i]!));
      out.push(
        <table key={k++}>
          <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, ctx)}</th>)}</tr></thead>
          <tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, x) => <td key={x}>{inline(c, ctx)}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }
    const first = LIST_ITEM.exec(line);
    if (first) {
      const base = first[1]!.length;
      const ordered = /\d/.test(first[2]!);
      const items: Array<{ text: string; children: string[] }> = [];
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        const m = LIST_ITEM.exec(l);
        if (m && m[1]!.length === base) items.push({ text: m[3]!, children: [] });
        else if (items.length && (indentOf(l) > base || (!l.trim() && lines[i + 1] !== undefined && indentOf(lines[i + 1]!) > base))) items[items.length - 1]!.children.push(l);
        else break;
      }
      const Tag = ordered ? "ol" : "ul";
      out.push(
        <Tag key={k++} className={items.some((it) => /^\[[ xX]\]\s/.test(it.text)) ? "md-tasks" : undefined}>
          {items.map((it, j) => {
            const task = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
            const sub = it.children.length ? blocks(it.children, ctx) : null;
            return (
              <li key={j}>
                {task && <input type="checkbox" checked={task[1] !== " "} disabled readOnly />}
                {inline(task ? task[2]! : it.text, ctx)}
                {sub}
              </li>
            );
          })}
        </Tag>,
      );
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i]!) && !(isTableRow(lines[i]!) && para.length); i++) para.push(lines[i]!.trim());
    if (para.length === 0) para.push(lines[i++]!.trim());
    out.push(<p key={k++}>{inline(para.join(" "), ctx)}</p>);
  }
  return out;
}
