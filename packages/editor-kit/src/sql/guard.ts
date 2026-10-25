/**
 * Safe mode: statements that can destroy data without meaning to — an UPDATE or DELETE with no WHERE, DROP, TRUNCATE,
 * ALTER … DROP — found before a script runs, so the query window can ask first. A heuristic over the text (comments and
 * string literals are blanked out first); it never blocks anything by itself.
 */

export interface RiskyStatement {
  kind: "delete-all" | "update-all" | "drop" | "truncate" | "alter-drop";
  /** What will happen, in plain words. */
  reason: string;
  /** The statement, shortened. */
  text: string;
}

/** Comments and quoted strings replaced by spaces (positions kept), so keywords inside them don't count. */
function blank(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? sql.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      out += sql.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < sql.length && !(sql[j] === close && sql[j + 1] !== close)) j += sql[j] === close ? 2 : 1;
      // Identifiers keep their letters (a table called "orders"); string literals are blanked.
      out += ch === "'" ? `'${" ".repeat(Math.max(0, j - i - 1))}'` : sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      // PostgreSQL dollar quoting: $$ … $$ or $tag$ … $tag$
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end < 0 ? sql.length : end + tag.length;
      out += sql.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** True when the statement filters its rows: a WHERE outside any parentheses (a subquery's WHERE doesn't count) that isn't a tautology like 1=1. */
function hasRealWhere(statement: string): boolean {
  let depth = 0;
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /^WHERE\b/i.test(statement.slice(i)) && (i === 0 || /\W/.test(statement[i - 1]!))) {
      const condition = statement.slice(i + 5).replace(/\s+/g, " ").trim();
      return !/^\(*\s*(1 ?= ?1|0 ?= ?0|true|'1' ?= ?'1')\s*\)*$/i.test(condition);
    }
  }
  return false;
}

const short = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 120 ? `${one.slice(0, 117)}…` : one;
};

export function findRiskyStatements(sql: string): RiskyStatement[] {
  const clean = blank(sql);
  // Statement boundaries: semicolons, and SQL Server's GO batch separator on its own line.
  const parts: Array<{ clean: string; raw: string }> = [];
  let start = 0;
  const re = /;|^\s*GO\s*$/gim;
  for (let m = re.exec(clean); ; m = re.exec(clean)) {
    const end = m ? m.index : clean.length;
    parts.push({ clean: clean.slice(start, end), raw: sql.slice(start, end) });
    if (!m) break;
    start = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  const out: RiskyStatement[] = [];
  for (const { clean: c, raw } of parts) {
    const s = c.trim();
    if (!s) continue;
    // Skip the CTE prefix: WITH x AS (…) DELETE …
    const body = s.replace(/^WITH\b[\s\S]*?\)\s*(?=(DELETE|UPDATE|INSERT|SELECT|MERGE)\b)/i, "");
    if (/^DELETE\b/i.test(body) && !hasRealWhere(body)) out.push({ kind: "delete-all", reason: "DELETE without WHERE removes every row", text: short(raw) });
    else if (/^UPDATE\b/i.test(body) && !hasRealWhere(body)) out.push({ kind: "update-all", reason: "UPDATE without WHERE changes every row", text: short(raw) });
    else if (/^TRUNCATE\b/i.test(body)) out.push({ kind: "truncate", reason: "TRUNCATE removes every row", text: short(raw) });
    else if (/^DROP\s+(TABLE|DATABASE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|INDEX|FUNCTION|PROCEDURE|PROC|SEQUENCE|TYPE|TRIGGER|USER|ROLE|LOGIN)\b/i.test(body)) {
      out.push({ kind: "drop", reason: `DROP ${/^DROP\s+(MATERIALIZED\s+VIEW|\w+)/i.exec(body)![1]!.toUpperCase()} deletes the object and its data`, text: short(raw) });
    } else if (/^ALTER\s+TABLE\b[\s\S]*\bDROP\b/i.test(body)) out.push({ kind: "alter-drop", reason: "ALTER TABLE … DROP removes a column or constraint", text: short(raw) });
  }
  return out;
}
