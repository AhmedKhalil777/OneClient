import { ATTRIBUTE, COMMENT, FUNCTION, KEYWORD, NUMBER, PROPERTY, STRING, TAG, TYPE, TokenBuilder, isDigit, isIdPart, isIdStart } from "./tokens.js";

/** What differs between the C-family languages; everything else (comments, strings, numbers, identifiers) is shared. */
export interface CFamilyConfig {
  keywords: ReadonlySet<string>;
  /** Built-in type names (`string`, `int`, …). */
  types: ReadonlySet<string>;
  /** Keywords after which the next name is a type name (`class Foo`, `new Foo`, `extends Foo`, …). */
  typeIntroducers: ReadonlySet<string>;
  /** `/…/flags` literals. */
  regexLiterals?: boolean;
  /** `` `a ${b} c` `` template literals. */
  templates?: boolean;
  /** `@"verbatim"`, `$"interpolated"` and `"""raw"""` strings. */
  csharpStrings?: boolean;
  /** `#region`, `#if` … at the start of a line. */
  preprocessor?: boolean;
  /** `@decorator`. */
  decorators?: boolean;
  /** `[Attribute]` at the start of a line. */
  attributeBrackets?: boolean;
  /** `<Tag attr>` elements. */
  jsx?: boolean;
}

/** After these words a `/` starts a regular expression, not a division. */
const REGEX_AFTER = new Set(["return", "typeof", "case", "delete", "void", "throw", "in", "of", "new", "else", "do", "yield", "await", "instanceof"]);

type Prev = { kind: "none" } | { kind: "word"; text: string } | { kind: "num" } | { kind: "punct"; ch: number };

/** Tokenizes C-family source. Tolerant by design: unterminated strings/comments just run to the line/file end. */
export function tokenizeCFamily(text: string, cfg: CFamilyConfig): TokenBuilder {
  const b = new TokenBuilder();
  const n = text.length;
  let i = 0;
  let lineStart = true;
  let prev = { kind: "none" } as Prev;
  let braceDepth = 0;
  /** Open `${` of template literals: the brace depth to come back to when their `}` closes. */
  const templates: number[] = [];

  const code = (k: number) => text.charCodeAt(k);

  /** First character after spaces/tabs from `k` (not crossing a line), as a char code; 0 at end of line. */
  const nextChar = (k: number): number => {
    while (k < n && (code(k) === 32 || code(k) === 9)) k++;
    return k < n ? code(k) : 0;
  };

  const scanTemplate = (from: number, bodyStart: number): void => {
    let j = bodyStart;
    while (j < n) {
      const c = code(j);
      if (c === 92) j += 2;
      else if (c === 96) {
        j++;
        b.push(from, j, STRING);
        i = j;
        return;
      } else if (c === 36 && code(j + 1) === 123) {
        b.push(from, j, STRING);
        templates.push(braceDepth);
        braceDepth++;
        i = j + 2;
        return;
      } else j++;
    }
    b.push(from, n, STRING);
    i = n;
  };

  /** A quoted string from `start` (at the opening quote); `escapes` false for verbatim strings (`""` is a quote there). */
  const scanQuoted = (start: number, quote: number, escapes: boolean, multiline: boolean): number => {
    let j = start + 1;
    while (j < n) {
      const c = code(j);
      if (escapes && c === 92) j += 2;
      else if (c === quote) {
        if (!escapes && code(j + 1) === quote) j += 2;
        else return j + 1;
      } else if (c === 10 && !multiline) return j;
      else j++;
    }
    return n;
  };

  const scanNumber = (start: number): number => {
    let j = start;
    const c = code(j);
    if (c === 48 && /[xXbBoO]/.test(text[j + 1] ?? "")) {
      j += 2;
      while (j < n && /[0-9a-fA-F_]/.test(text[j]!)) j++;
    } else {
      while (j < n && (isDigit(code(j)) || code(j) === 95)) j++;
      if (code(j) === 46 && isDigit(code(j + 1))) {
        j++;
        while (j < n && (isDigit(code(j)) || code(j) === 95)) j++;
      }
      if ((code(j) === 101 || code(j) === 69) && (isDigit(code(j + 1)) || ((code(j + 1) === 43 || code(j + 1) === 45) && isDigit(code(j + 2))))) {
        j += 2;
        while (j < n && isDigit(code(j))) j++;
      }
    }
    while (j < n && isIdPart(code(j))) j++; // suffixes: n, f, m, UL, …
    return j;
  };

  const scanRegex = (start: number): number => {
    let j = start + 1;
    let inClass = false;
    while (j < n) {
      const c = code(j);
      if (c === 10) return -1;
      if (c === 92) j += 2;
      else if (c === 91) (inClass = true), j++;
      else if (c === 93) (inClass = false), j++;
      else if (c === 47 && !inClass) {
        j++;
        while (j < n && isIdPart(code(j))) j++;
        return j;
      } else j++;
    }
    return -1;
  };

  const classifyWord = (s: number, e: number): void => {
    const w = text.slice(s, e);
    const afterDot = s > 0 && code(s - 1) === 46 && (s < 2 || code(s - 2) !== 46);
    const call = nextChar(e) === 40;
    const introducer = prev.kind === "word" && cfg.typeIntroducers.has(prev.text);
    if (!afterDot && cfg.keywords.has(w)) b.push(s, e, KEYWORD);
    else if (!afterDot && cfg.types.has(w)) b.push(s, e, TYPE);
    else if (call) b.push(s, e, FUNCTION);
    else if (afterDot) b.push(s, e, introducer ? TYPE : PROPERTY);
    else if (introducer) b.push(s, e, TYPE);
    else {
      const first = code(s);
      if (first >= 65 && first <= 90 && /[a-z]/.test(w)) b.push(s, e, TYPE);
    }
    prev = { kind: "word", text: w };
  };

  while (i < n) {
    const c = code(i);

    if (c === 10) {
      lineStart = true;
      i++;
      continue;
    }
    if (c === 32 || c === 9 || c === 13) {
      i++;
      continue;
    }
    const atLineStart = lineStart;
    lineStart = false;

    // comments
    if (c === 47 && code(i + 1) === 47) {
      let e = text.indexOf("\n", i);
      if (e === -1) e = n;
      b.push(i, e, COMMENT);
      i = e;
      lineStart = false;
      continue;
    }
    if (c === 47 && code(i + 1) === 42) {
      const close = text.indexOf("*/", i + 2);
      const e = close === -1 ? n : close + 2;
      b.push(i, e, COMMENT);
      i = e;
      continue;
    }

    // preprocessor directives
    if (c === 35 && cfg.preprocessor && atLineStart) {
      let j = i + 1;
      while (j < n && (code(j) === 32 || code(j) === 9)) j++;
      const ws = j;
      while (j < n && isIdPart(code(j))) j++;
      if (j > ws) b.push(i, j, KEYWORD);
      i = Math.max(j, i + 1);
      continue;
    }

    // strings
    if (c === 34 || c === 39) {
      if (cfg.csharpStrings && c === 34 && code(i + 1) === 34 && code(i + 2) === 34) {
        let q = 3;
        while (code(i + q) === 34) q++;
        const close = text.indexOf('"'.repeat(q), i + q);
        const e = close === -1 ? n : close + q;
        b.push(i, e, STRING);
        i = e;
      } else {
        const e = scanQuoted(i, c, true, false);
        b.push(i, e, STRING);
        i = e;
      }
      prev = { kind: "num" };
      continue;
    }
    if (cfg.csharpStrings && (c === 36 || c === 64)) {
      // $"…", @"…", $@"…", @$"…"
      let j = i;
      let verbatim = false;
      while (j < n && (code(j) === 36 || code(j) === 64) && j - i < 2) {
        if (code(j) === 64) verbatim = true;
        j++;
      }
      if (code(j) === 34) {
        const e = scanQuoted(j, 34, !verbatim, verbatim);
        b.push(i, e, STRING);
        i = e;
        prev = { kind: "num" };
        continue;
      }
    }
    if (c === 96 && cfg.templates) {
      scanTemplate(i, i + 1);
      prev = { kind: "num" };
      continue;
    }

    // braces (template `${ … }` bookkeeping)
    if (c === 123) {
      braceDepth++;
      prev = { kind: "punct", ch: c };
      i++;
      continue;
    }
    if (c === 125) {
      braceDepth--;
      if (templates.length && templates[templates.length - 1] === braceDepth) {
        templates.pop();
        scanTemplate(i + 1, i + 1);
        prev = { kind: "num" };
        continue;
      }
      prev = { kind: "punct", ch: c };
      i++;
      continue;
    }

    // numbers
    if (isDigit(c) || (c === 46 && isDigit(code(i + 1)))) {
      const e = scanNumber(i);
      b.push(i, e, NUMBER);
      i = e;
      prev = { kind: "num" };
      continue;
    }

    // regex literal
    if (c === 47 && cfg.regexLiterals) {
      const allowed = prev.kind === "none" || (prev.kind === "punct" && prev.ch !== 41 && prev.ch !== 93 && prev.ch !== 125) || (prev.kind === "word" && REGEX_AFTER.has(prev.text));
      if (allowed) {
        const e = scanRegex(i);
        if (e !== -1) {
          b.push(i, e, STRING);
          i = e;
          prev = { kind: "num" };
          continue;
        }
      }
    }

    // decorators / attributes
    if (c === 64 && cfg.decorators && isIdStart(code(i + 1))) {
      let j = i + 1;
      while (j < n && (isIdPart(code(j)) || code(j) === 46)) j++;
      b.push(i, j, ATTRIBUTE);
      i = j;
      prev = { kind: "num" };
      continue;
    }
    if (c === 91 && cfg.attributeBrackets && (atLineStart || (prev.kind === "punct" && prev.ch === 93))) {
      let j = i + 1;
      while (j < n && code(j) === 32) j++;
      const ws = j;
      while (j < n && (isIdPart(code(j)) || code(j) === 46)) j++;
      if (code(j) === 58) {
        // [assembly: Foo] / [return: Foo]
        b.push(ws, j, KEYWORD);
        j++;
        while (j < n && code(j) === 32) j++;
        const ns = j;
        while (j < n && (isIdPart(code(j)) || code(j) === 46)) j++;
        b.push(ns, j, ATTRIBUTE);
      } else b.push(ws, j, ATTRIBUTE);
      i = j;
      prev = { kind: "num" };
      continue;
    }

    // JSX / TSX tags
    if (c === 60 && cfg.jsx && (isIdStart(code(i + 1)) || (code(i + 1) === 47 && isIdStart(code(i + 2)))) && (prev.kind === "none" || prev.kind === "punct" || (prev.kind === "word" && REGEX_AFTER.has(prev.text)))) {
      let j = i + (code(i + 1) === 47 ? 2 : 1);
      const ws = j;
      while (j < n && (isIdPart(code(j)) || code(j) === 46 || code(j) === 45)) j++;
      b.push(ws, j, TAG);
      i = j;
      prev = { kind: "num" };
      continue;
    }

    // identifiers & keywords
    if (isIdStart(c) || (c === 64 && cfg.csharpStrings && isIdStart(code(i + 1))) || (c === 35 && !cfg.preprocessor && isIdStart(code(i + 1)))) {
      const s = i;
      i++;
      while (i < n && isIdPart(code(i))) i++;
      if (c === 64) classifyVerbatimIdentifier(s, i);
      else classifyWord(s, i);
      continue;
    }

    prev = { kind: "punct", ch: c };
    i++;
  }
  return b;

  function classifyVerbatimIdentifier(s: number, e: number): void {
    // `@class` — an identifier that merely looks like a keyword
    if (nextChar(e) === 40) b.push(s, e, FUNCTION);
    prev = { kind: "num" };
  }
}

