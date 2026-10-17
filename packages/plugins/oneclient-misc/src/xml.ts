import type { DocumentSymbol, FileEditorError, SymbolsResult, TokenClass, TokensResult, TransformResult } from "@oneclient/plugin-api";

/**
 * A small, tolerant XML parser that remembers where everything is. It exists because the editor
 * needs offsets (breadcrumbs, highlighting) and must keep working on half-typed documents: problems
 * are collected as errors while parsing carries on.
 */

export interface XmlAttr {
  name: string;
  /** Raw value without quotes. */
  value: string;
  quote: '"' | "'" | "";
  hasValue: boolean;
  start: number;
  nameEnd: number;
  /** Offset just past the attribute (past the closing quote). */
  end: number;
}

export interface XmlElement {
  type: "element";
  name: string;
  /** Offset of "<". */
  start: number;
  /** Offset just past ">" of the start tag. */
  openEnd: number;
  /** Offset of "</" of the end tag, or -1 when self-closing / never closed. */
  closeStart: number;
  /** Offset just past the whole element. */
  end: number;
  selfClosing: boolean;
  /** `<a/>` rather than `<a />` — formatting keeps the author's style. */
  tightSlash: boolean;
  attrs: XmlAttr[];
  children: XmlNode[];
}

export interface XmlLeaf {
  type: "text" | "comment" | "cdata" | "pi" | "doctype";
  start: number;
  end: number;
}

export type XmlNode = XmlElement | XmlLeaf;
export interface XmlError {
  message: string;
  offset: number;
}

const MAX_DEPTH = 1500;
const NAME_START = /[A-Za-z_:À-￿]/;

export function parseXml(text: string): { nodes: XmlNode[]; errors: XmlError[] } {
  const errors: XmlError[] = [];
  const root: XmlNode[] = [];
  const stack: XmlElement[] = [];
  const push = (node: XmlNode) => (stack.length ? stack[stack.length - 1]!.children : root).push(node);
  const err = (message: string, offset: number) => errors.push({ message, offset });
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "<") {
      const next = text.indexOf("<", i);
      const end = next === -1 ? text.length : next;
      push({ type: "text", start: i, end });
      i = end;
      continue;
    }

    if (text.startsWith("<!--", i)) {
      const close = text.indexOf("-->", i + 4);
      if (close === -1) err("Comment is not closed", i);
      const end = close === -1 ? text.length : close + 3;
      push({ type: "comment", start: i, end });
      i = end;
    } else if (text.startsWith("<![CDATA[", i)) {
      const close = text.indexOf("]]>", i + 9);
      if (close === -1) err("CDATA section is not closed", i);
      const end = close === -1 ? text.length : close + 3;
      push({ type: "cdata", start: i, end });
      i = end;
    } else if (text.startsWith("<?", i)) {
      const close = text.indexOf("?>", i + 2);
      if (close === -1) err("Processing instruction is not closed", i);
      const end = close === -1 ? text.length : close + 2;
      push({ type: "pi", start: i, end });
      i = end;
    } else if (text.startsWith("<!", i)) {
      const end = scanDoctype(text, i);
      if (end === -1) err("Declaration is not closed", i);
      const stop = end === -1 ? text.length : end;
      push({ type: "doctype", start: i, end: stop });
      i = stop;
    } else if (text.startsWith("</", i)) {
      const m = /^<\/([^\s>/]*)\s*(>?)/.exec(text.slice(i, i + 512));
      const name = m?.[1] ?? "";
      const end = i + (m?.[0].length ?? 2);
      if (!m?.[2]) err("End tag is missing its \">\"", i);
      // Close the nearest open element with this name; anything opened inside it was left unclosed.
      let depth = stack.length - 1;
      while (depth >= 0 && stack[depth]!.name !== name) depth--;
      if (depth < 0) {
        err(`Unexpected end tag </${name}>`, i);
      } else {
        while (stack.length - 1 > depth) {
          const open = stack.pop()!;
          err(`Element <${open.name}> is not closed (expected </${open.name}> before </${name}>)`, open.start);
          open.end = i;
        }
        const el = stack.pop()!;
        el.closeStart = i;
        el.end = end;
      }
      i = end;
    } else if (NAME_START.test(text[i + 1] ?? "")) {
      const parsed = parseStartTag(text, i, err);
      push(parsed.el);
      i = parsed.el.openEnd;
      if (!parsed.el.selfClosing) {
        if (stack.length >= MAX_DEPTH) {
          err("Elements are nested too deeply", i);
          parsed.el.end = text.length;
          i = text.length;
        } else {
          stack.push(parsed.el);
        }
      }
    } else {
      err("Unescaped \"<\" — use &lt;", i);
      push({ type: "text", start: i, end: i + 1 });
      i++;
    }
  }

  for (const open of stack) {
    err(`Element <${open.name}> is not closed`, open.start);
    open.end = text.length;
  }
  return { nodes: root, errors };
}

/** End offset of `<!DOCTYPE …>` including an internal `[ … ]` subset, or -1. */
function scanDoctype(text: string, start: number): number {
  let depth = 0;
  let quote = "";
  for (let i = start + 2; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ">" && depth <= 0) return i + 1;
  }
  return -1;
}

function parseStartTag(text: string, start: number, err: (m: string, o: number) => void): { el: XmlElement } {
  let i = start + 1;
  const nameMatch = /^[^\s/>]+/.exec(text.slice(i, i + 256))!;
  const el: XmlElement = {
    type: "element",
    name: nameMatch[0],
    start,
    openEnd: start,
    closeStart: -1,
    end: start,
    selfClosing: false,
    tightSlash: false,
    attrs: [],
    children: [],
  };
  i += nameMatch[0].length;

  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) {
      err(`Start tag <${el.name}> is not closed`, start);
      el.openEnd = el.end = text.length;
      return { el };
    }
    if (text[i] === ">") {
      el.openEnd = el.end = i + 1;
      return { el };
    }
    if (text.startsWith("/>", i)) {
      el.selfClosing = true;
      el.tightSlash = !/\s/.test(text[i - 1] ?? "");
      el.openEnd = el.end = i + 2;
      return { el };
    }
    const nameM = /^[^\s=/>"']+/.exec(text.slice(i, i + 256));
    if (!nameM) {
      err(`Unexpected character "${text[i]}" in <${el.name}>`, i);
      i++;
      continue;
    }
    const attr: XmlAttr = { name: nameM[0], value: "", quote: "", hasValue: false, start: i, nameEnd: i + nameM[0].length, end: i + nameM[0].length };
    i = attr.nameEnd;
    let j = i;
    while (j < text.length && /\s/.test(text[j]!)) j++;
    if (text[j] === "=") {
      attr.hasValue = true;
      j++;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      const q = text[j];
      if (q === '"' || q === "'") {
        const close = text.indexOf(q, j + 1);
        if (close === -1) {
          err(`Attribute "${attr.name}" has an unterminated value`, j);
          attr.value = text.slice(j + 1);
          attr.quote = q;
          attr.end = i = text.length;
        } else {
          attr.value = text.slice(j + 1, close);
          attr.quote = q;
          attr.end = i = close + 1;
        }
      } else {
        const bare = /^[^\s>]*/.exec(text.slice(j))![0].replace(/\/$/, "");
        err(`Attribute "${attr.name}" must have a quoted value`, j);
        attr.value = bare;
        attr.end = i = j + bare.length;
      }
    } else {
      err(`Attribute "${attr.name}" has no value`, attr.start);
    }
    el.attrs.push(attr);
  }
}

// ---- Formatting ----------------------------------------------------------------------------------------------

function renderStartTag(el: XmlElement): string {
  const attrs = el.attrs.map((a) => ` ${a.name}${a.hasValue ? `=${a.quote}${a.value}${a.quote}` : ""}`).join("");
  return `<${el.name}${attrs}${el.selfClosing ? (el.tightSlash ? "/>" : " />") : ">"}`;
}

const isBlank = (text: string, n: XmlNode) => n.type === "text" && text.slice(n.start, n.end).trim() === "";

/**
 * Re-indents the document. Elements that contain only elements/comments get one child per line;
 * elements with text are left exactly as written (whitespace inside text can be significant), so
 * formatting never changes what the document means.
 */
export function formatXml(text: string, tabSize: number, insertSpaces: boolean): TransformResult {
  if (text.trim() === "") return { ok: true, text };
  const { nodes, errors } = parseXml(text);
  const first = errors[0];
  if (first) return { ok: false, error: { message: `Can't format: ${first.message}`, offset: first.offset } };

  const unit = insertSpaces ? " ".repeat(Math.max(1, tabSize)) : "\t";
  const lines: string[] = [];

  const emit = (siblings: XmlNode[], depth: number) => {
    const pad = unit.repeat(depth);
    let blankBefore = false;
    let wroteAny = false;
    for (const node of siblings) {
      if (node.type === "text" && isBlank(text, node)) {
        // A blank line between siblings is the author's grouping — keep one.
        blankBefore = (text.slice(node.start, node.end).match(/\n/g)?.length ?? 0) >= 2;
        continue;
      }
      if (blankBefore && wroteAny) lines.push("");
      blankBefore = false;
      wroteAny = true;

      if (node.type === "text") {
        lines.push(pad + text.slice(node.start, node.end).trim());
      } else if (node.type !== "element") {
        lines.push(pad + text.slice(node.start, node.end));
      } else if (node.selfClosing) {
        lines.push(pad + renderStartTag(node));
      } else {
        const content = node.children.filter((c) => !isBlank(text, c));
        const structural = content.every((c) => c.type === "element" || c.type === "comment" || c.type === "pi");
        if (content.length === 0) {
          lines.push(`${pad}${renderStartTag(node)}</${node.name}>`);
        } else if (!structural) {
          // Text, CDATA or mixed content: keep the inside byte-for-byte.
          lines.push(pad + text.slice(node.start, node.end));
        } else {
          lines.push(pad + renderStartTag(node));
          emit(node.children, depth + 1);
          lines.push(`${pad}</${node.name}>`);
        }
      }
    }
  };

  emit(nodes, 0);
  return { ok: true, text: lines.join("\n") + (text.endsWith("\n") ? "\n" : "") };
}

// ---- Document symbols (breadcrumbs) --------------------------------------------------------------------------

const MAX_SYMBOLS = 20_000;
const IDENTIFYING_ATTRS = ["id", "name", "key", "ref", "type", "class", "Include", "Label"];

function elementSymbols(nodes: XmlNode[], budget: { left: number }): DocumentSymbol[] {
  const out: DocumentSymbol[] = [];
  for (const node of nodes) {
    if (node.type !== "element" || --budget.left < 0) continue;
    const attr = IDENTIFYING_ATTRS.map((n) => node.attrs.find((a) => a.name === n)).find((a) => a && a.value !== "");
    const detail = attr ? `${attr.name}="${attr.value.length > 36 ? `${attr.value.slice(0, 35)}…` : attr.value}"` : undefined;
    const children = elementSymbols(node.children, budget);
    out.push({
      name: node.name,
      ...(detail ? { detail } : {}),
      kind: "element",
      start: node.start,
      end: node.end,
      ...(children.length ? { children } : {}),
    });
  }
  return out;
}

export function xmlSymbols(text: string): SymbolsResult {
  const { nodes, errors } = parseXml(text);
  const first = errors[0];
  const error: FileEditorError | undefined = first ? { message: first.message, offset: first.offset } : undefined;
  return { ok: true, symbols: elementSymbols(nodes, { left: MAX_SYMBOLS }), ...(error ? { error } : {}) };
}

// ---- Syntax highlighting -------------------------------------------------------------------------------------

const CLASSES: TokenClass[] = ["tag", "attribute", "string", "comment", "keyword", "punctuation"];
const [TAG, ATTRIBUTE, STRING, COMMENT, KEYWORD, PUNCTUATION] = [0, 1, 2, 3, 4, 5];

export function xmlTokens(text: string): TokensResult {
  const { nodes } = parseXml(text);
  const tokens: number[] = [];
  const add = (start: number, end: number, cls: number) => {
    if (end > start) tokens.push(start, end, cls);
  };

  const walk = (siblings: XmlNode[]) => {
    for (const n of siblings) {
      if (n.type === "comment") add(n.start, n.end, COMMENT);
      else if (n.type === "cdata") add(n.start, n.end, STRING);
      else if (n.type === "pi" || n.type === "doctype") add(n.start, n.end, KEYWORD);
      else if (n.type === "element") {
        add(n.start, n.start + 1, PUNCTUATION);
        add(n.start + 1, n.start + 1 + n.name.length, TAG);
        for (const a of n.attrs) {
          add(a.start, a.nameEnd, ATTRIBUTE);
          if (a.hasValue) {
            const eq = text.indexOf("=", a.nameEnd);
            if (eq !== -1 && eq < a.end) add(eq, eq + 1, PUNCTUATION);
            const valueStart = a.end - a.value.length - (a.quote ? 2 : 0);
            add(valueStart, a.end, STRING);
          }
        }
        const closeLen = n.selfClosing ? 2 : 1;
        if (n.openEnd - closeLen >= n.start) add(n.openEnd - closeLen, n.openEnd, PUNCTUATION);
        walk(n.children);
        if (n.closeStart !== -1) {
          add(n.closeStart, n.closeStart + 2, PUNCTUATION);
          add(n.closeStart + 2, n.closeStart + 2 + n.name.length, TAG);
          add(n.end - 1, n.end, PUNCTUATION);
        }
      }
    }
  };
  walk(nodes);
  return { ok: true, tokens, classes: CLASSES };
}
