import { ATTRIBUTE, COMMENT, FUNCTION, KEYWORD, NUMBER, PROPERTY, STRING, TAG, TYPE, TokenBuilder, VARIABLE, isDigit, isIdPart, isIdStart } from "./tokens.js";

export interface CssOptions {
  /** `// line comments` (SCSS, Less). */
  lineComments?: boolean;
}

const CONDITION_WORDS = new Set(["and", "or", "not", "only", "from", "to", "through", "if", "else", "in"]);

/**
 * Tokenizes CSS (and, tolerantly, SCSS/Less). Each statement is classified by what ends it: a `{` makes it a
 * selector (so nested rules work), `;` or `}` makes it a declaration; `@…` starts an at-rule.
 */
export function tokenizeCss(text: string, opts: CssOptions = {}): TokenBuilder {
  const b = new TokenBuilder();
  const n = text.length;
  const code = (k: number) => text.charCodeAt(k);
  let i = 0;

  /** End of a comment starting at `k`, or -1 if there is none. */
  const commentEnd = (k: number): number => {
    if (code(k) === 47 && code(k + 1) === 42) {
      const close = text.indexOf("*/", k + 2);
      return close === -1 ? n : close + 2;
    }
    if (opts.lineComments && code(k) === 47 && code(k + 1) === 47) {
      const nl = text.indexOf("\n", k);
      return nl === -1 ? n : nl;
    }
    return -1;
  };

  const stringEnd = (k: number): number => {
    const q = code(k);
    let j = k + 1;
    while (j < n) {
      const c = code(j);
      if (c === 92) j += 2;
      else if (c === q) return j + 1;
      else if (c === 10) return j;
      else j++;
    }
    return n;
  };

  /** Index of the `{`, `;` or `}` that ends the statement starting at `k` (or `n`). */
  const terminator = (k: number): number => {
    let depth = 0;
    let j = k;
    while (j < n) {
      const c = code(j);
      const ce = commentEnd(j);
      if (ce !== -1) j = ce;
      else if (c === 34 || c === 39) j = stringEnd(j);
      else if (c === 40 || c === 91) {
        depth++;
        j++;
      } else if (c === 41 || c === 93) {
        depth = Math.max(0, depth - 1);
        j++;
      } else if (c === 35 && code(j + 1) === 123) {
        const close = text.indexOf("}", j);
        j = close === -1 ? n : close + 1; // #{interpolation}
      } else if (depth === 0 && (c === 123 || c === 59 || c === 125)) return j;
      else j++;
    }
    return n;
  };

  const number = (k: number): number => {
    let j = k;
    if (code(j) === 43 || code(j) === 45) j++;
    while (j < n && isDigit(code(j))) j++;
    if (code(j) === 46 && isDigit(code(j + 1))) {
      j++;
      while (j < n && isDigit(code(j))) j++;
    }
    if ((code(j) === 101 || code(j) === 69) && (isDigit(code(j + 1)) || ((code(j + 1) === 45 || code(j + 1) === 43) && isDigit(code(j + 2))))) {
      j += 2;
      while (j < n && isDigit(code(j))) j++;
    }
    if (code(j) === 37) j++;
    else while (j < n && ((code(j) >= 65 && code(j) <= 90) || (code(j) >= 97 && code(j) <= 122))) j++;
    return j;
  };

  const word = (k: number): number => {
    let j = k;
    while (j < n && (isIdPart(code(j)) || code(j) === 45 || code(j) === 92)) j++;
    return j;
  };

  /** Values and at-rule preludes: strings, numbers with units, colors, `fn(`, `--vars`, `!important`. */
  const value = (from: number, to: number, feature: boolean): void => {
    let j = from;
    let parenFeature = false;
    while (j < to) {
      const c = code(j);
      const ce = commentEnd(j);
      if (ce !== -1) {
        b.push(j, Math.min(ce, to), COMMENT);
        j = ce;
      } else if (c === 34 || c === 39) {
        const e = Math.min(stringEnd(j), to);
        b.push(j, e, STRING);
        j = e;
      } else if (c === 35 && /[0-9a-fA-F]/.test(text[j + 1] ?? "")) {
        let e = j + 1;
        while (e < to && /[0-9a-fA-F]/.test(text[e]!)) e++;
        b.push(j, e, NUMBER);
        j = e;
      } else if (isDigit(c) || (c === 46 && isDigit(code(j + 1))) || ((c === 45 || c === 43) && (isDigit(code(j + 1)) || (code(j + 1) === 46 && isDigit(code(j + 2)))) && !isIdPart(code(j - 1)))) {
        const e = Math.min(number(j), to);
        b.push(j, e, NUMBER);
        j = e;
      } else if (c === 33) {
        let e = j + 1;
        while (e < to && code(e) === 32) e++;
        const we = word(e);
        if (we > e) b.push(j, we, KEYWORD);
        j = Math.max(we, j + 1);
      } else if (c === 36 || (c === 64 && isIdStart(code(j + 1)))) {
        const e = word(j + 1);
        b.push(j, e, VARIABLE);
        j = Math.max(e, j + 1);
      } else if (isIdStart(c) || c === 45) {
        const e = Math.min(word(j), to);
        if (e === j) {
          j++;
          continue;
        }
        const w = text.slice(j, e);
        if (w.startsWith("--")) b.push(j, e, VARIABLE);
        else if (code(e) === 40) b.push(j, e, FUNCTION);
        else if (feature && parenFeature && code(e) === 58) b.push(j, e, PROPERTY);
        else if (feature && CONDITION_WORDS.has(w)) b.push(j, e, KEYWORD);
        j = e;
        parenFeature = false;
      } else {
        parenFeature = feature && c === 40;
        j++;
      }
    }
  };

  const selector = (from: number, to: number): void => {
    let j = from;
    while (j < to) {
      const c = code(j);
      const ce = commentEnd(j);
      if (ce !== -1) {
        b.push(j, Math.min(ce, to), COMMENT);
        j = ce;
      } else if (c === 34 || c === 39) {
        const e = Math.min(stringEnd(j), to);
        b.push(j, e, STRING);
        j = e;
      } else if (c === 46 && isIdStart(code(j + 1))) {
        const e = word(j + 1);
        b.push(j, e, TYPE);
        j = e;
      } else if (c === 35 && (isIdPart(code(j + 1)) || code(j + 1) === 45)) {
        const e = word(j + 1);
        b.push(j, e, VARIABLE);
        j = e;
      } else if (c === 91) {
        // [attr=value]
        let e = j + 1;
        while (e < to && code(e) === 32) e++;
        const ne = word(e);
        b.push(e, ne, ATTRIBUTE);
        let k = ne;
        while (k < to && code(k) !== 93) {
          if (code(k) === 34 || code(k) === 39) {
            const se = Math.min(stringEnd(k), to);
            b.push(k, se, STRING);
            k = se;
          } else if (isIdStart(code(k)) && /[=~|^$*]/.test(text[k - 1] ?? "")) {
            const we = word(k);
            b.push(k, we, STRING);
            k = we;
          } else k++;
        }
        j = k + 1;
      } else if (c === 58) {
        const start = j;
        j++;
        if (code(j) === 58) j++;
        const e = word(j);
        b.push(start, e, KEYWORD);
        j = Math.max(e, j);
      } else if (c === 36 || (c === 64 && isIdStart(code(j + 1)))) {
        const e = word(j + 1);
        b.push(j, e, VARIABLE);
        j = Math.max(e, j + 1);
      } else if (isDigit(c)) {
        const e = Math.min(number(j), to);
        b.push(j, e, NUMBER);
        j = e;
      } else if (isIdStart(c) || c === 45) {
        const e = word(j);
        if (e > j) b.push(j, e, TAG);
        j = Math.max(e, j + 1);
      } else j++;
    }
  };

  const declaration = (from: number, to: number): void => {
    let depth = 0;
    let colon = -1;
    for (let j = from; j < to; j++) {
      const c = code(j);
      if (c === 40 || c === 91) depth++;
      else if (c === 41 || c === 93) depth--;
      else if (c === 58 && depth === 0) {
        colon = j;
        break;
      }
    }
    if (colon === -1) {
      value(from, to, false);
      return;
    }
    let s = from;
    while (s < colon && /\s/.test(text[s]!)) s++;
    let e = colon;
    while (e > s && /\s/.test(text[e - 1]!)) e--;
    const name = text.slice(s, e);
    if (name.startsWith("--") || name.startsWith("$") || name.startsWith("@")) b.push(s, e, VARIABLE);
    else if (e > s && !/[\s/*]/.test(name)) b.push(s, e, PROPERTY);
    value(colon + 1, to, false);
  };

  while (i < n) {
    const c = code(i);
    if (c <= 32 || c === 123 || c === 125 || c === 59) {
      i++;
      continue;
    }
    const ce = commentEnd(i);
    if (ce !== -1) {
      b.push(i, ce, COMMENT);
      i = ce;
      continue;
    }
    if (c === 64 && isIdStart(code(i + 1))) {
      const e = word(i + 1);
      b.push(i, e, KEYWORD);
      const end = terminator(e);
      value(e, end, true);
      i = end;
      continue;
    }
    const end = terminator(i);
    if (code(end) === 123) selector(i, end);
    else declaration(i, end);
    i = Math.max(end, i + 1);
  }
  return b;
}
