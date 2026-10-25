export interface Statement {
  text: string;
  /** 1-based line of the statement's first token. */
  startLine: number;
}

/**
 * Splits a MySQL script into statements the way the `mysql` client does: on `;` — or on whatever a `DELIMITER` command
 * set (stored programs need `DELIMITER //` so the `;` inside their body doesn't end the statement). Not split inside
 * 'strings' and "strings" (backslash escapes and doubled quotes), `identifiers`, and comments (`-- `, `#`, block comments).
 */
export function splitStatements(script: string): Statement[] {
  const out: Statement[] = [];
  let delimiter = ";";
  let start = 0;
  let i = 0;
  let line = 1;
  let startLine = 1;

  const push = (end: number) => {
    const text = script.slice(start, end);
    // Comments only (or nothing) is not a statement.
    if (!text.replace(/--[ \t][^\n]*|--$|#[^\n]*|\/\*(?!!)[\s\S]*?\*\//gm, "").trim()) return;
    // Drop leading blanks and comments (the rest of the previous line…), so startLine is the first real token.
    const lead = /^(?:\s+|--[ \t][^\n]*|#[^\n]*|\/\*(?!!)[\s\S]*?\*\/)*/.exec(text)![0];
    out.push({ text: text.slice(lead.length).trimEnd(), startLine: startLine + (lead.match(/\n/g)?.length ?? 0) });
  };

  while (i < script.length) {
    const ch = script[i]!;
    const atLineStart = i === 0 || script[i - 1] === "\n";

    // A DELIMITER command: its own line, not part of a statement in progress.
    if (atLineStart && /^delimiter\s/i.test(script.slice(i, i + 10)) && !script.slice(start, i).trim()) {
      const eol = script.indexOf("\n", i);
      const lineEnd = eol === -1 ? script.length : eol;
      const next = script.slice(i + 9, lineEnd).trim();
      if (next) delimiter = next;
      i = lineEnd;
      start = i;
      continue;
    }

    if (ch === "\n") {
      line++;
      i++;
      if (!script.slice(start, i).trim()) {
        start = i;
        startLine = line;
      }
    } else if ((ch === "-" && script[i + 1] === "-" && (script[i + 2] === undefined || /\s/.test(script[i + 2]!))) || ch === "#") {
      while (i < script.length && script[i] !== "\n") i++;
    } else if (ch === "/" && script[i + 1] === "*") {
      const end = script.indexOf("*/", i + 2);
      const stop = end === -1 ? script.length : end + 2;
      line += script.slice(i, stop).match(/\n/g)?.length ?? 0;
      i = stop;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      i++;
      while (i < script.length) {
        const c = script[i]!;
        if (c === "\n") line++;
        if (c === "\\" && ch !== "`") i += 2;
        else if (c === ch && script[i + 1] === ch) i += 2;
        else if (c === ch) {
          i++;
          break;
        } else i++;
      }
    } else if (script.startsWith(delimiter, i)) {
      push(i);
      i += delimiter.length;
      start = i;
      startLine = line;
    } else i++;
  }
  push(script.length);
  return out;
}
