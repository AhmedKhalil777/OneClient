/**
 * A small GitHub-flavoured Markdown block parser for chat replies: fenced code (with ```mermaid kept apart), headings,
 * tables, block quotes, nested and task lists, rules and paragraphs. It returns a plain tree; the renderer turns it
 * into React nodes, so nothing a model writes is ever inserted as HTML.
 */

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  /** `open`: the closing fence has not arrived yet (the reply is still streaming). */
  | { t: "code"; lang: string; code: string; open: boolean }
  | { t: "quote"; children: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Array<{ checked: boolean | null; children: Block[] }> }
  | { t: "table"; align: Align[]; head: string[]; rows: string[][] }
  | { t: "hr" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Splits a table row on unescaped pipes outside `code spans`. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let tick = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      tick = !tick;
      cur += ch;
    } else if (ch === "|" && !tick) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const alignOf = (cell: string): Align => {
  const c = cell.trim();
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
};

const startsBlock = (line: string, next: string | undefined): boolean =>
  FENCE.test(line) || HR.test(line) || HEADING.test(line) || /^\s{0,3}>/.test(line) || ITEM.test(line) || isTableStart(line, next);

function isTableStart(line: string, next: string | undefined): boolean {
  if (next === undefined || !line.includes("|") || !SEPARATOR.test(next) || !next.includes("-")) return false;
  return splitRow(line).length === splitRow(next).length && (next.includes("|") || splitRow(line).length > 1);
}

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const indent = /^\s*/.exec(line)![0].length;
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i]!;
        if (new RegExp(`^\\s{0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(l)) {
          closed = true;
          i++;
          break;
        }
        body.push(l.slice(Math.min(indent, /^\s*/.exec(l)![0].length)));
        i++;
      }
      out.push({ t: "code", lang: (fence[2] ?? "").toLowerCase(), code: body.join("\n"), open: !closed });
      continue;
    }

    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: "h", level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && (/^\s{0,3}>/.test(lines[i]!) || (lines[i]!.trim() && inner.length && !startsBlock(lines[i]!, lines[i + 1])))) {
        inner.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
        i++;
      }
      out.push({ t: "quote", children: parseBlocks(inner) });
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
        const cells = splitRow(lines[i]!);
        rows.push(head.map((_, k) => cells[k] ?? ""));
        i++;
      }
      out.push({ t: "table", align, head, rows });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const base = item[1]!.length;
      const ordered = /\d/.test(item[2]!);
      const start = ordered ? Number.parseInt(item[2]!, 10) : 1;
      const items: Array<{ checked: boolean | null; children: Block[] }> = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]!);
        if (!m || m[1]!.length !== base || /\d/.test(m[2]!) !== ordered) break;
        const bodyIndent = base + m[2]!.length + 1;
        const body: string[] = [m[3]!];
        i++;
        while (i < lines.length) {
          const l = lines[i]!;
          if (!l.trim()) {
            // a blank line stays in the item only if what follows is indented further
            let j = i;
            while (j < lines.length && !lines[j]!.trim()) j++;
            if (j < lines.length && /^\s*/.exec(lines[j]!)![0].length > base && !(ITEM.test(lines[j]!) && /^\s*/.exec(lines[j]!)![0].length === base)) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          const ind = /^\s*/.exec(l)![0].length;
          if (ind <= base) {
            const other = ITEM.exec(l);
            if (other || startsBlock(l, lines[i + 1])) break;
            body.push(l.trim()); // lazy continuation of the paragraph
            i++;
            continue;
          }
          body.push(l.slice(Math.min(ind, bodyIndent)));
          i++;
        }
        let checked: boolean | null = null;
        const task = /^\[([ xX])\]\s+/.exec(body[0]!);
        if (task) {
          checked = task[1] !== " ";
          body[0] = body[0]!.slice(task[0].length);
        }
        items.push({ checked, children: parseBlocks(body) });
        // blank lines between items of the same list
        let j = i;
        while (j < lines.length && !lines[j]!.trim()) j++;
        const next = j < lines.length ? ITEM.exec(lines[j]!) : null;
        if (next && next[1]!.length === base && /\d/.test(next[2]!) === ordered) i = j;
      }
      out.push({ t: "list", ordered, start, items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (para.length === 0 || !startsBlock(lines[i]!, lines[i + 1]))) para.push(lines[i++]!.trim());
    out.push({ t: "p", text: para.join("\n") });
  }
  return out;
}
