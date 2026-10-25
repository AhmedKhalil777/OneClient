import { COMMENT, KEYWORD, NUMBER, OPERATOR, PROPERTY, STRING, TYPE, TokenBuilder, VARIABLE } from "./tokens.js";

const LITERALS = new Set(["true", "false", "null", "yes", "no", "on", "off", "~", "True", "False", "Null", "TRUE", "FALSE", "NULL"]);
const NUMBER_RE = /^[-+]?(?:0x[0-9a-fA-F_]+|0o[0-7]+|(?:\d[\d_]*)(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+|\.inf|\.nan)$/i;
const isSpace = (c: string | undefined) => c === undefined || c === " " || c === "\t" || c === "\r" || c === "\n";

/**
 * Tokenizes YAML line by line: keys, comments, document markers, quoted strings, numbers, `true/null`-style literals,
 * anchors/aliases (`&a`, `*a`), tags (`!!str`), block scalars (`|`, `>`) and flow collections (`{a: 1, b: [x]}`).
 * It does not validate; odd input just stays uncolored.
 */
export function tokenizeYaml(text: string): TokenBuilder {
  const b = new TokenBuilder();
  const n = text.length;
  let ls = 0;
  /** Indent of the line that opened a block scalar, or -1. */
  let blockIndent = -1;
  let flow = 0;

  const quotedEnd = (k: number, limit: number): number => {
    const q = text[k];
    let j = k + 1;
    while (j < limit) {
      if (q === '"' && text[j] === "\\") j += 2;
      else if (text[j] === q) {
        if (q === "'" && text[j + 1] === "'") j += 2;
        else return j + 1;
      } else j++;
    }
    return limit;
  };

  const value = (from: number, le: number, first: boolean): void => {
    let j = from;
    let atStart = first;
    while (j < le) {
      const c = text[j]!;
      if (c === " " || c === "\t" || c === "\r") {
        j++;
        continue;
      }
      if (c === "#" && (j === ls || isSpace(text[j - 1]))) {
        b.push(j, le, COMMENT);
        return;
      }
      if (c === '"' || c === "'") {
        const e = quotedEnd(j, le);
        // a quoted flow key: {"a": 1}
        let k = e;
        while (k < le && text[k] === " ") k++;
        b.push(j, e, flow > 0 && text[k] === ":" && isSpace(text[k + 1]) ? PROPERTY : STRING);
        j = e;
      } else if (c === "&" || c === "*") {
        let e = j + 1;
        while (e < le && !isSpace(text[e]) && !",[]{}".includes(text[e]!)) e++;
        b.push(j, e, VARIABLE);
        j = Math.max(e, j + 1);
      } else if (c === "!") {
        let e = j + 1;
        while (e < le && !isSpace(text[e])) e++;
        b.push(j, e, TYPE);
        j = e;
      } else if ((c === "|" || c === ">") && atStart) {
        let e = j + 1;
        while (e < le && /[-+0-9]/.test(text[e]!)) e++;
        b.push(j, e, OPERATOR);
        blockIndent = indentOf(ls);
        j = e;
      } else if ("[{".includes(c)) {
        flow++;
        j++;
      } else if ("]}".includes(c)) {
        flow = Math.max(0, flow - 1);
        j++;
      } else if (c === "," || c === ":") {
        j++;
      } else {
        // plain scalar: up to a comment, a flow delimiter, or (in flow) a ": "
        let e = j;
        while (e < le) {
          const d = text[e]!;
          if (d === "#" && isSpace(text[e - 1])) break;
          if (flow > 0 && (",]}".includes(d) || (d === ":" && isSpace(text[e + 1])))) break;
          e++;
        }
        let t = e;
        while (t > j && (text[t - 1] === " " || text[t - 1] === "\t" || text[t - 1] === "\r")) t--;
        const word = text.slice(j, t);
        if (flow > 0 && text[e] === ":") b.push(j, t, PROPERTY);
        else if (LITERALS.has(word)) b.push(j, t, KEYWORD);
        else if (NUMBER_RE.test(word)) b.push(j, t, NUMBER);
        j = Math.max(e, j + 1);
      }
      atStart = false;
    }
  };

  const indentOf = (start: number): number => {
    let j = start;
    while (text[j] === " " || text[j] === "\t") j++;
    return j - start;
  };

  while (ls < n) {
    let le = text.indexOf("\n", ls);
    if (le === -1) le = n;
    let j = ls;
    while (j < le && (text[j] === " " || text[j] === "\t")) j++;
    const indent = j - ls;
    const blank = j >= le || (j === le - 1 && text[j] === "\r");

    if (blockIndent >= 0 && (blank || indent > blockIndent)) {
      if (!blank) b.push(j, text[le - 1] === "\r" ? le - 1 : le, STRING);
    } else {
      blockIndent = -1;
      if (!blank) lineTokens(j, le);
    }
    ls = le + 1;
  }
  return b;

  function lineTokens(start: number, le: number): void {
    let j = start;
    if (text[j] === "#") {
      b.push(j, le, COMMENT);
      return;
    }
    if (indentOf(ls) === 0 && (text.startsWith("---", j) || text.startsWith("...", j)) && isSpace(text[j + 3])) {
      b.push(j, j + 3, KEYWORD);
      value(j + 3, le, true);
      return;
    }
    if (flow === 0) {
      if (text[j] === "%") {
        b.push(j, le, KEYWORD); // %YAML / %TAG directives
        return;
      }
      // sequence dashes: "- - a"
      while (text[j] === "-" && isSpace(text[j + 1]) && j < le) {
        j++;
        while (j < le && (text[j] === " " || text[j] === "\t")) j++;
      }
      // a key?
      const c = text[j];
      let keyEnd = -1;
      let colon = -1;
      if (c === '"' || c === "'") {
        keyEnd = quotedEnd(j, le);
        let k = keyEnd;
        while (k < le && text[k] === " ") k++;
        if (text[k] === ":" && isSpace(text[k + 1])) colon = k;
      } else if (c !== undefined && !"[{&*!|>%@`#".includes(c) && j < le) {
        for (let k = j; k < le; k++) {
          if (text[k] === "#" && isSpace(text[k - 1])) break;
          if (text[k] === ":" && isSpace(text[k + 1])) {
            colon = k;
            break;
          }
        }
        if (colon !== -1) {
          keyEnd = colon;
          while (keyEnd > j && (text[keyEnd - 1] === " " || text[keyEnd - 1] === "\t")) keyEnd--;
        }
      }
      if (colon !== -1 && keyEnd > j) {
        b.push(j, keyEnd, PROPERTY);
        value(colon + 1, le, true);
        return;
      }
    }
    value(j, le, true);
  }
}
