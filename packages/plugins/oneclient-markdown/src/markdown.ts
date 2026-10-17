import hljs from "highlight.js/lib/common";
import MarkdownIt from "markdown-it";
import type { DocumentSymbol, PreviewResult, SymbolsResult, TokenClass, TokensResult } from "@oneclient/plugin-api";

interface Line {
  text: string;
  start: number;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      lines.push({ text: text.slice(start), start });
      return lines;
    }
    lines.push({ text: text.slice(start, nl), start });
    start = nl + 1;
  }
}

/** Fence tracking shared by the outline and the highlighter: returns, per line, whether it is inside/on a fenced block. */
function fencedLines(lines: Line[]): boolean[] {
  const fenced: boolean[] = [];
  let open: { char: string; len: number } | null = null;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);
    if (!open) {
      if (m) {
        open = { char: m[1]![0]!, len: m[1]!.length };
        fenced.push(true);
      } else {
        fenced.push(false);
      }
    } else {
      fenced.push(true);
      if (m && m[1]![0] === open.char && m[1]!.length >= open.len && /^ {0,3}[`~]+\s*$/.test(line.text)) open = null;
    }
  }
  return fenced;
}

// ---- Outline (breadcrumbs) -----------------------------------------------------------------------------------

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

function plainHeading(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

interface Heading {
  level: number;
  name: string;
  start: number;
}

function findHeadings(text: string): Heading[] {
  const lines = splitLines(text);
  const fenced = fencedLines(lines);
  const headings: Heading[] = [];
  lines.forEach((line, i) => {
    if (fenced[i]) return;
    const atx = ATX.exec(line.text);
    if (atx) {
      headings.push({ level: atx[1]!.length, name: plainHeading(atx[2]!) || "(empty heading)", start: line.start });
      return;
    }
    // Setext: a text line underlined with === (h1) or --- (h2).
    const next = lines[i + 1];
    const underline = next && /^ {0,3}(=+|-+)[ \t]*$/.exec(next.text);
    if (underline && !fenced[i + 1] && line.text.trim() !== "" && !/^ {0,3}([-*+]|\d+[.)])\s|^ {0,3}>|^\s*\|/.test(line.text) && !ATX.test(line.text)) {
      headings.push({ level: underline[1]![0] === "=" ? 1 : 2, name: plainHeading(line.text), start: line.start });
    }
  });
  return headings;
}

/** Headings nested by level; each spans to the next heading of the same or higher level. */
export function markdownSymbols(text: string): SymbolsResult {
  const headings = findHeadings(text);
  const root: DocumentSymbol[] = [];
  type Open = { level: number; symbol: { name: string; kind: "heading"; start: number; end: number; children: DocumentSymbol[] } };
  const stack: Open[] = [];
  for (const h of headings) {
    while (stack.length && stack[stack.length - 1]!.level >= h.level) {
      stack.pop()!.symbol.end = h.start;
    }
    const symbol = { name: h.name, kind: "heading" as const, start: h.start, end: text.length, children: [] as DocumentSymbol[] };
    (stack.length ? stack[stack.length - 1]!.symbol.children : root).push(symbol);
    stack.push({ level: h.level, symbol });
  }
  // Drop empty `children` arrays so leaf headings are plain symbols.
  const clean = (list: DocumentSymbol[]): DocumentSymbol[] =>
    list.map((s) => {
      const kids = s.children ? clean([...s.children]) : [];
      const { children: _children, ...rest } = s;
      return kids.length ? { ...rest, children: kids } : rest;
    });
  return { ok: true, symbols: clean(root) };
}

// ---- Syntax highlighting -------------------------------------------------------------------------------------

const CLASSES: TokenClass[] = ["heading", "code", "quote", "list", "punctuation", "strong", "emphasis", "link", "comment"];
const [HEADING, CODE, QUOTE, LIST, PUNCT, STRONG, EMPHASIS, LINK, COMMENT] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

const INLINE =
  /(`+)([^`\n]|[^`\n][^\n]*?[^`\n])\1(?!`)|<!--.*?-->|!?\[[^\]\n]*\]\([^)\n]*\)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|(?<![\w])_[^_\s][^_\n]*_(?![\w])/g;

export function markdownTokens(text: string): TokensResult {
  const lines = splitLines(text);
  const fenced = fencedLines(lines);
  const tokens: number[] = [];
  const add = (s: number, e: number, c: number) => {
    if (e > s) tokens.push(s, e, c);
  };

  lines.forEach((line, i) => {
    const end = line.start + line.text.length;
    if (fenced[i]) return add(line.start, end, CODE);
    if (ATX.test(line.text)) return add(line.start, end, HEADING);
    const next = lines[i + 1];
    if (next && /^ {0,3}(=+|-+)[ \t]*$/.test(next.text) && line.text.trim() !== "" && !fenced[i + 1] && !/^ {0,3}([-*+]|\d+[.)])\s|^ {0,3}>/.test(line.text)) {
      return add(line.start, end, HEADING); // setext title (its underline is colored below)
    }
    if (/^ {0,3}(=+|-+)[ \t]*$/.test(line.text) && i > 0 && lines[i - 1]!.text.trim() !== "") return add(line.start, end, HEADING);
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line.text)) return add(line.start, end, PUNCT);
    if (/^ {0,3}>/.test(line.text)) return add(line.start, end, QUOTE);

    let contentStart = 0;
    const list = /^(\s*)([-*+]|\d+[.)])(?=\s)/.exec(line.text);
    if (list) {
      add(line.start + list[1]!.length, line.start + list[0].length, LIST);
      contentStart = list[0].length;
    }
    const body = line.text.slice(contentStart);
    for (const m of body.matchAll(INLINE)) {
      const s = line.start + contentStart + m.index!;
      const e = s + m[0].length;
      const first = m[0][0]!;
      add(s, e, m[1] ? CODE : m[0].startsWith("<!--") ? COMMENT : first === "[" || first === "!" ? LINK : m[0].startsWith("**") || m[0].startsWith("__") ? STRONG : EMPHASIS);
    }
  });
  return { ok: true, tokens, classes: CLASSES };
}

// ---- Preview -----------------------------------------------------------------------------------------------------

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/g, "-") || "section"
  );
}

function createRenderer(): MarkdownIt {
  const md: MarkdownIt = new MarkdownIt({
    // Raw HTML in the source is shown as text, never rendered: a Markdown file from anywhere stays inert.
    html: false,
    linkify: true,
    typographer: false,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
          return `<pre class="hljs"><code class="language-${md.utils.escapeHtml(lang)}">${html}</code></pre>`;
        } catch {
          /* fall through to plain */
        }
      }
      return ""; // markdown-it escapes it itself
    },
  });

  // Headings get GitHub-style ids so [links](#to-a-section) work.
  md.renderer.rules.heading_open = (tokens, idx, options, env: { slugs?: Map<string, number> }, self) => {
    const content = tokens[idx + 1]?.content ?? "";
    const base = slugify(content);
    const slugs = (env.slugs ??= new Map());
    const n = slugs.get(base) ?? 0;
    slugs.set(base, n + 1);
    tokens[idx]!.attrSet("id", n === 0 ? base : `${base}-${n}`);
    return self.renderToken(tokens, idx, options);
  };

  // GitHub task lists: "- [ ] todo" / "- [x] done" become (disabled) checkboxes.
  md.core.ruler.after("inline", "task-lists", (state) => {
    const t = state.tokens;
    for (let i = 2; i < t.length; i++) {
      const inline = t[i]!;
      if (inline.type !== "inline" || t[i - 1]!.type !== "paragraph_open" || t[i - 2]!.type !== "list_item_open") continue;
      const first = inline.children?.[0];
      const m = first?.type === "text" ? /^\[([ xX])\]\s+/.exec(first.content) : null;
      if (!first || !m) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token("html_inline", "", 0);
      box.content = `<input type="checkbox" disabled${m[1] !== " " ? " checked" : ""}> `;
      inline.children!.unshift(box);
      t[i - 2]!.attrJoin("class", "task-list-item");
    }
  });

  return md;
}

let renderer: MarkdownIt | undefined;

export function markdownPreview(text: string): PreviewResult {
  renderer ??= createRenderer();
  return { ok: true, html: renderer.render(text, {}), css: PREVIEW_CSS };
}

/** Styles for what the renderer emits; colors come from the theme variables the editor injects into the preview. */
const PREVIEW_CSS = `
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-section,.hljs-doctag,.hljs-meta .hljs-keyword{color:var(--oc-syntax-keyword,#569cd6)}
.hljs-string,.hljs-regexp,.hljs-meta .hljs-string,.hljs-addition{color:var(--oc-syntax-string,#ce9178)}
.hljs-number,.hljs-symbol,.hljs-bullet{color:var(--oc-syntax-number,#b5cea8)}
.hljs-comment,.hljs-quote,.hljs-deletion{color:var(--oc-syntax-comment,#6a9955)}
.hljs-title,.hljs-title.function_,.hljs-function .hljs-title{color:var(--oc-syntax-function,#dcdcaa)}
.hljs-type,.hljs-built_in,.hljs-class .hljs-title,.hljs-title.class_{color:var(--oc-syntax-type,#4ec9b0)}
.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable,.hljs-property,.hljs-params{color:var(--oc-syntax-variable,#9cdcfe)}
.hljs-tag,.hljs-name,.hljs-selector-id,.hljs-selector-class{color:var(--oc-syntax-keyword,#569cd6)}
.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:bold}
li.task-list-item{list-style:none;margin-left:-1.4em}
li.task-list-item input{margin-right:.4em;vertical-align:middle}
`;
