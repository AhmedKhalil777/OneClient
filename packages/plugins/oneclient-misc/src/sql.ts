import type { DocumentSymbol, SymbolsResult, TokenClass, TokensResult, TransformResult } from "@oneclient/plugin-api";

/**
 * T-SQL / SQL support for the Files editor: highlighting, a statement outline for the breadcrumbs, a formatter and
 * keyword-case actions. It works on a token stream rather than a full parser, so it keeps working on half-typed
 * scripts. Formatting only ever changes whitespace (and, when asked, the case of well-known keywords) — never strings,
 * comments or identifiers.
 */

// ---- tokenizer ---------------------------------------------------------------------------------------------------

type Kind = "ws" | "lineComment" | "blockComment" | "string" | "quoted" | "variable" | "number" | "word" | "punct";

interface Tok {
  kind: Kind;
  start: number;
  end: number;
  text: string;
}

const WORD_START = /[A-Za-z_#À-￿]/;
const WORD_PART = /[\w#$À-￿]/;

export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const push = (kind: Kind, start: number, end: number) => out.push({ kind, start, end, text: text.slice(start, end) });
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const start = i;
    if (/\s/.test(c)) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      push("ws", start, i);
    } else if (c === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      push("lineComment", start, i);
    } else if (c === "/" && text[i + 1] === "*") {
      let depth = 1; // T-SQL block comments nest
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") (depth++, (i += 2));
        else if (text[i] === "*" && text[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
      push("blockComment", start, i);
    } else if (c === "'" || ((c === "N" || c === "n") && text[i + 1] === "'")) {
      i += c === "'" ? 1 : 2;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      push("string", start, i);
    } else if (c === "[" || c === '"') {
      const close = c === "[" ? "]" : '"';
      i++;
      while (i < text.length) {
        if (text[i] === close) {
          if (text[i + 1] === close) i += 2;
          else {
            i++;
            break;
          }
        } else if (text[i] === "\n" && c === "[") break;
        else i++;
      }
      push("quoted", start, i);
    } else if (c === "@") {
      i++;
      if (text[i] === "@") i++;
      while (i < text.length && WORD_PART.test(text[i]!)) i++;
      push("variable", start, i);
    } else if (/\d/.test(c) || (c === "." && /\d/.test(text[i + 1] ?? ""))) {
      if (c === "0" && /[xX]/.test(text[i + 1] ?? "")) {
        i += 2;
        while (i < text.length && /[0-9a-fA-F]/.test(text[i]!)) i++;
      } else {
        while (i < text.length && /[\d.]/.test(text[i]!)) i++;
        if (/[eE]/.test(text[i] ?? "") && /[\d+-]/.test(text[i + 1] ?? "")) {
          i += 2;
          while (i < text.length && /\d/.test(text[i]!)) i++;
        }
      }
      push("number", start, i);
    } else if (WORD_START.test(c)) {
      while (i < text.length && WORD_PART.test(text[i]!)) i++;
      push("word", start, i);
    } else {
      i++;
      push("punct", start, i);
    }
  }
  return out;
}

// ---- vocabulary --------------------------------------------------------------------------------------------------

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const KEYWORDS = set(`ADD ALL ALTER AS ASC AUTHORIZATION BACKUP BEGIN BREAK BULK BY CASCADE CASE CHECK CLOSE CLUSTERED COLUMN COMMIT
  CONSTRAINT CONTINUE CREATE CROSS CURSOR DATABASE DBCC DEALLOCATE DECLARE DEFAULT DELETE DENY DESC DISTINCT DROP ELSE END ESCAPE
  EXCEPT EXEC EXECUTE EXISTS FETCH FOR FOREIGN FROM FULL FUNCTION GOTO GRANT GROUP HAVING IDENTITY IF INDEX INNER INSERT INTERSECT
  INTO JOIN KEY LEFT MERGE NONCLUSTERED OFF ON OPEN OPTION ORDER OUTER OVER PARTITION PERCENT PIVOT PRIMARY PRINT PROC PROCEDURE
  RAISERROR READ REFERENCES RESTORE RETURN RETURNS REVOKE RIGHT ROLLBACK SCHEMA SELECT SET TABLE THEN THROW TOP TRAN TRANSACTION
  TRIGGER TRUNCATE TRY CATCH UNION UNIQUE UNPIVOT UPDATE USE VALUES VIEW WAITFOR WHEN WHERE WHILE WITH GO APPLY OUTPUT OFFSET
  ROWS ONLY NEXT MATCHED USING NOCOUNT NOLOCK`);
const OPERATOR_WORDS = set("AND OR NOT IN IS NULL LIKE BETWEEN EXISTS SOME ANY");
const TYPES = set(`BIGINT INT SMALLINT TINYINT BIT DECIMAL NUMERIC MONEY SMALLMONEY FLOAT REAL DATE TIME DATETIME DATETIME2
  SMALLDATETIME DATETIMEOFFSET CHAR VARCHAR NCHAR NVARCHAR TEXT NTEXT BINARY VARBINARY IMAGE UNIQUEIDENTIFIER XML SQL_VARIANT
  HIERARCHYID GEOGRAPHY GEOMETRY SYSNAME MAX`);
const FUNCTIONS = set(`COUNT SUM AVG MIN MAX COUNT_BIG STDEV STRING_AGG ROW_NUMBER RANK DENSE_RANK NTILE LAG LEAD FIRST_VALUE
  LAST_VALUE CAST CONVERT TRY_CAST TRY_CONVERT PARSE ISNULL COALESCE NULLIF IIF CHOOSE GETDATE GETUTCDATE SYSDATETIME
  DATEADD DATEDIFF DATENAME DATEPART DAY MONTH YEAR EOMONTH FORMAT LEN DATALENGTH LEFT RIGHT SUBSTRING CHARINDEX PATINDEX
  REPLACE REPLICATE REVERSE LOWER UPPER LTRIM RTRIM TRIM CONCAT CONCAT_WS STUFF STRING_SPLIT QUOTENAME STR ABS CEILING FLOOR
  ROUND POWER SQRT RAND NEWID OBJECT_ID OBJECT_NAME DB_ID DB_NAME SCHEMA_NAME SCOPE_IDENTITY OPENJSON JSON_VALUE JSON_QUERY
  ISJSON ERROR_MESSAGE ERROR_NUMBER ERROR_LINE`);

/**
 * Words the formatter / keyword-case actions change the case of. Deliberately conservative: only words that are
 * (almost) never identifiers, because a case-sensitive collation makes identifier case significant.
 */
const CASE_WORDS = set(`SELECT FROM WHERE GROUP BY HAVING ORDER INSERT INTO VALUES UPDATE SET DELETE JOIN INNER LEFT RIGHT FULL OUTER
  CROSS APPLY ON AS AND OR NOT IN IS NULL LIKE BETWEEN EXISTS UNION ALL DISTINCT TOP CASE WHEN THEN ELSE END CREATE ALTER DROP TABLE VIEW
  PROCEDURE PROC FUNCTION INDEX TRIGGER BEGIN DECLARE EXEC EXECUTE IF WHILE RETURN RETURNS WITH TRUNCATE MERGE USING PRIMARY KEY FOREIGN
  REFERENCES CONSTRAINT DEFAULT UNIQUE CLUSTERED NONCLUSTERED ASC DESC OVER PARTITION FETCH TRANSACTION
  COMMIT ROLLBACK PRINT GO USE`);

// ---- highlighting ------------------------------------------------------------------------------------------------

const CLASSES: TokenClass[] = ["keyword", "string", "number", "comment", "type", "function", "operator", "variable"];
const [KEYWORD, STRING, NUMBER, COMMENT, TYPE, FUNCTION, OPERATOR, VARIABLE] = [0, 1, 2, 3, 4, 5, 6, 7];

export function sqlTokens(text: string): TokensResult {
  const toks = tokenize(text);
  const out: number[] = [];
  toks.forEach((t, i) => {
    switch (t.kind) {
      case "lineComment":
      case "blockComment":
        out.push(t.start, t.end, COMMENT);
        break;
      case "string":
        out.push(t.start, t.end, STRING);
        break;
      case "number":
        out.push(t.start, t.end, NUMBER);
        break;
      case "variable":
        out.push(t.start, t.end, VARIABLE);
        break;
      case "word": {
        const up = t.text.toUpperCase();
        const prev = toks[i - 1];
        if (prev?.text === ".") break; // a column / object name after "schema."
        const call = toks[i + 1]?.text === "(";
        if (call && FUNCTIONS.has(up)) out.push(t.start, t.end, FUNCTION);
        else if (OPERATOR_WORDS.has(up) || ["JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "FULL", "CROSS"].includes(up)) out.push(t.start, t.end, OPERATOR);
        else if (KEYWORDS.has(up)) out.push(t.start, t.end, KEYWORD);
        else if (TYPES.has(up)) out.push(t.start, t.end, TYPE);
        else if (FUNCTIONS.has(up)) out.push(t.start, t.end, FUNCTION);
        break;
      }
      default:
        break;
    }
  });
  return { ok: true, tokens: out, classes: CLASSES };
}

// ---- statements & outline ------------------------------------------------------------------------------------------

interface Statement {
  /** Significant (non-whitespace, non-comment) token indexes into the token array. */
  first: number;
  last: number;
  start: number;
  end: number;
  words: string[];
}

const STARTERS = set("SELECT INSERT UPDATE DELETE MERGE CREATE ALTER DROP TRUNCATE EXEC EXECUTE DECLARE PRINT USE GRANT REVOKE DENY RAISERROR THROW BACKUP RESTORE");
/** A statement-start word that continues the previous statement instead when it follows one of these. */
const CONTINUES = set("UNION ALL EXCEPT INTERSECT INTO FOR AS");

const isTrivia = (t: Tok) => t.kind === "ws" || t.kind === "lineComment" || t.kind === "blockComment";

/** True for a `GO` batch separator: a lone GO (optionally with a count) on its own line. */
function isGo(toks: Tok[], i: number, text: string): boolean {
  const t = toks[i]!;
  if (t.kind !== "word" || t.text.toUpperCase() !== "GO") return false;
  const lineStart = text.lastIndexOf("\n", t.start - 1) + 1;
  const lineEnd = text.indexOf("\n", t.end) === -1 ? text.length : text.indexOf("\n", t.end);
  return /^\s*$/.test(text.slice(lineStart, t.start)) && /^\s*(\d+\s*)?(--.*)?$/.test(text.slice(t.end, lineEnd));
}

interface Batch {
  statements: Statement[];
  start: number;
  end: number;
}

function splitBatches(text: string, toks: Tok[]): Batch[] {
  const batches: Batch[] = [];
  let cur: Statement | null = null;
  let batch: Batch = { statements: [], start: 0, end: 0 };
  let depth = 0;
  let prevSig: Tok | undefined;

  const close = () => {
    if (cur) {
      batch.statements.push(cur);
      cur = null;
    }
  };
  const endBatch = () => {
    close();
    if (batch.statements.length) {
      batch.start = batch.statements[0]!.start;
      batch.end = batch.statements[batch.statements.length - 1]!.end;
      batches.push(batch);
    }
    batch = { statements: [], start: 0, end: 0 };
    depth = 0;
    prevSig = undefined;
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (isTrivia(t)) continue;
    if (isGo(toks, i, text)) {
      endBatch();
      continue;
    }
    if (t.text === ";") {
      if (cur) (cur as Statement).end = t.end;
      close();
      prevSig = t;
      continue;
    }
    if (t.text === "(") depth++;
    else if (t.text === ")") depth = Math.max(0, depth - 1);

    const up = t.kind === "word" ? t.text.toUpperCase() : "";
    const startsNew =
      depth === 0 &&
      STARTERS.has(up) &&
      !(prevSig && prevSig.kind === "word" && CONTINUES.has(prevSig.text.toUpperCase())) &&
      !((up === "SELECT" || up === "EXEC" || up === "EXECUTE") && (cur as Statement | null)?.words[0] === "INSERT") &&
      !(up === "UPDATE" && (cur as Statement | null)?.words[0] === "SELECT") && // SELECT … FOR UPDATE
      !(up === "DELETE" && (cur as Statement | null)?.words[0] === "MERGE") &&
      !(up === "INSERT" && (cur as Statement | null)?.words[0] === "MERGE") &&
      !(up === "UPDATE" && (cur as Statement | null)?.words[0] === "MERGE");
    if (startsNew || !cur) {
      close();
      cur = { first: i, last: i, start: t.start, end: t.end, words: [] };
    }
    const s = cur as Statement;
    s.last = i;
    s.end = t.end;
    if (t.kind === "word" && s.words.length < 8) s.words.push(up);
    prevSig = t;
  }
  endBatch();
  return batches;
}

const OBJECT_KINDS = set("TABLE VIEW PROCEDURE PROC FUNCTION TRIGGER INDEX SCHEMA DATABASE TYPE SEQUENCE SYNONYM LOGIN USER ROLE");

/** The first identifier-ish thing after the object kind: `dbo.Users`, `[dbo].[Users]`, `Users`. */
function nameAfter(text: string, toks: Tok[], from: number, limit: number): string {
  let out = "";
  let i = from;
  while (i <= limit) {
    const t = toks[i]!;
    if (isTrivia(t)) {
      i++;
      continue;
    }
    if (t.kind === "word" || t.kind === "quoted") {
      if (out && !out.endsWith(".")) break;
      out += t.text;
    } else if (t.text === "." && out) out += ".";
    else break;
    i++;
  }
  return out.replace(/\.$/, "");
}

function describe(text: string, toks: Tok[], s: Statement): { name: string; detail?: string; object: boolean } {
  const w = s.words;
  const sig: Tok[] = [];
  for (let i = s.first; i <= s.last; i++) if (!isTrivia(toks[i]!)) sig.push(toks[i]!);
  const idxOf = (k: number) => toks.indexOf(sig[k]!);
  const w0 = w[0] ?? "";

  if (w0 === "CREATE" || w0 === "ALTER") {
    let k = 1;
    let label = w0;
    if (w[k] === "OR" && w[k + 1] === "ALTER") (label += " OR ALTER", (k += 2));
    while (w[k] && !OBJECT_KINDS.has(w[k]!) && k < 5) k++; // CREATE UNIQUE NONCLUSTERED INDEX …
    const kind = w[k];
    if (kind && OBJECT_KINDS.has(kind)) {
      const name = nameAfter(text, toks, idxOf(sig.findIndex((t) => t.kind === "word" && t.text.toUpperCase() === kind && toks.indexOf(t) >= s.first) + 1), s.last);
      return { name: `${label} ${kind}${name ? ` ${name}` : ""}`, object: true };
    }
  }
  if (w0 === "DROP" || w0 === "TRUNCATE") {
    const k = sig.findIndex((t, n) => n > 0 && t.kind === "word" && (OBJECT_KINDS.has(t.text.toUpperCase()) || t.text.toUpperCase() === "TABLE"));
    const name = k >= 0 ? nameAfter(text, toks, idxOf(k + 1), s.last) : "";
    return { name: `${w0} ${k >= 0 ? sig[k]!.text.toUpperCase() : ""}${name ? ` ${name}` : ""}`.trim(), object: false };
  }
  if (w0 === "SELECT") {
    const f = sig.findIndex((t) => t.kind === "word" && t.text.toUpperCase() === "FROM");
    const into = sig.findIndex((t) => t.kind === "word" && t.text.toUpperCase() === "INTO");
    const from = f >= 0 ? nameAfter(text, toks, idxOf(f + 1), s.last) : "";
    return { name: "SELECT", ...(from ? { detail: `FROM ${from}` } : into >= 0 ? { detail: `INTO ${nameAfter(text, toks, idxOf(into + 1), s.last)}` } : {}), object: false };
  }
  if (w0 === "INSERT" || w0 === "MERGE") {
    const k = sig.findIndex((t) => t.kind === "word" && ["INTO"].includes(t.text.toUpperCase()));
    const name = k >= 0 ? nameAfter(text, toks, idxOf(k + 1), s.last) : "";
    return { name: `${w0}${name ? ` INTO ${name}` : ""}`, object: false };
  }
  if (w0 === "UPDATE") return { name: `UPDATE ${nameAfter(text, toks, idxOf(1), s.last)}`.trim(), object: false };
  if (w0 === "DELETE") {
    const k = w[1] === "FROM" ? 2 : 1;
    return { name: `DELETE FROM ${nameAfter(text, toks, idxOf(k), s.last)}`.trim(), object: false };
  }
  if (w0 === "EXEC" || w0 === "EXECUTE") return { name: `EXEC ${nameAfter(text, toks, idxOf(1), s.last)}`.trim(), object: false };
  if (w0 === "DECLARE") return { name: `DECLARE ${sig[1]?.text ?? ""}`.trim(), object: false };
  return { name: w0 || sig[0]?.text || "statement", object: false };
}

const MAX_SYMBOLS = 20_000;

export function sqlSymbols(text: string): SymbolsResult {
  const toks = tokenize(text);
  const symbols: DocumentSymbol[] = [];
  let budget = MAX_SYMBOLS;
  for (const batch of splitBatches(text, toks)) {
    const [first, ...rest] = batch.statements;
    if (!first || budget <= 0) continue;
    const d = describe(text, toks, first);
    if (d.object && rest.length > 0) {
      // An object with a body (procedure, function, trigger…): the later statements of the batch nest under it.
      const children: DocumentSymbol[] = rest.map((s) => {
        const c = describe(text, toks, s);
        return { name: c.name, ...(c.detail ? { detail: c.detail } : {}), kind: "other" as const, start: s.start, end: s.end };
      });
      budget -= children.length + 1;
      symbols.push({ name: d.name, kind: "object", start: batch.start, end: batch.end, children });
    } else {
      for (const s of batch.statements) {
        const c = describe(text, toks, s);
        budget--;
        symbols.push({ name: c.name, ...(c.detail ? { detail: c.detail } : {}), kind: c.object ? "object" : "other", start: s.start, end: s.end });
      }
    }
  }
  return { ok: true, symbols };
}

// ---- keyword case --------------------------------------------------------------------------------------------------

function recase(text: string, upper: boolean): string {
  const toks = tokenize(text);
  let out = "";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === "word" && CASE_WORDS.has(t.text.toUpperCase()) && toks[i - 1]?.text !== "." && toks[i + 1]?.text !== "." && !(/^(left|right)$/i.test(t.text) && toks[i + 1]?.text === "(")) out += upper ? t.text.toUpperCase() : t.text.toLowerCase();
    else out += t.text;
  }
  return out;
}

export const uppercaseKeywords = (text: string): TransformResult => ({ ok: true, text: recase(text, true) });
export const lowercaseKeywords = (text: string): TransformResult => ({ ok: true, text: recase(text, false) });

// ---- formatter -------------------------------------------------------------------------------------------------------

/** Words that start a new line when they begin a clause of a statement (at parenthesis depth 0). */
const CLAUSE_STARTS = set("SELECT FROM WHERE GROUP HAVING ORDER UNION EXCEPT INTERSECT VALUES SET");
const JOIN_WORDS = set("JOIN INNER LEFT RIGHT FULL CROSS OUTER");
/** Clauses whose AND / OR / ON continuation lines are indented under the clause. */
const CONDITION_CLAUSES = set("WHERE HAVING JOIN");
/** Clauses whose top-level commas put each item on its own line. */
const LIST_CLAUSES = set("SELECT GROUP ORDER SET");

/**
 * Re-lays out a script: one clause per line (SELECT / FROM / JOIN / WHERE / GROUP BY / …), one item per line in select
 * lists, AND/OR/ON indented, CREATE TABLE columns one per line, blank line between statements, keywords upper-cased.
 * Whitespace is the only thing that changes (plus the case of reserved words), so the script means the same afterwards.
 */
export function formatSql(text: string, tabSize = 4, insertSpaces = true): TransformResult {
  const unit = insertSpaces ? " ".repeat(Math.max(1, tabSize)) : "\t";
  const toks = tokenize(text);
  const items: Array<{ t: Tok; index: number; gap: string }> = [];
  let gap = "";
  toks.forEach((t, index) => {
    if (t.kind === "ws") gap = t.text;
    else {
      items.push({ t, index, gap });
      gap = "";
    }
  });
  if (items.length === 0) return { ok: true, text };

  let out = "";
  let depth = 0;
  let stmtWords: string[] = [];
  let clause = "";
  let betweenPending = false;
  let columnList = false; // inside the column list of CREATE TABLE
  let prev: Tok | undefined;
  let statementEnded = true; // the previous statement was closed with ";" or "GO"
  let afterGo = false;

  let multiline = false; // the current statement already spans several lines
  const atLineStart = () => /\n[ \t]*$/.test(out);
  const breakLine = (level: number) => {
    out = `${out.replace(/[ \t]+$/, "")}\n${unit.repeat(level)}`;
    multiline = true;
  };

  for (let n = 0; n < items.length; n++) {
    const { t, index, gap: before } = items[n]!;
    const next = items[n + 1]?.t;
    const up = t.kind === "word" ? t.text.toUpperCase() : "";
    const isComment = t.kind === "lineComment" || t.kind === "blockComment";

    if (isGo(toks, index, text)) {
      out = `${out.replace(/\s+$/, "")}\n${t.text.toUpperCase()}`;
      depth = 0;
      stmtWords = [];
      clause = "";
      columnList = false;
      statementEnded = true;
      afterGo = true;
      prev = t;
      continue;
    }

    const startsStatement = !isComment && (statementEnded || (depth === 0 && startsNewStatement(up, prev, stmtWords[0])));

    if (!out) {
      /* first token: nothing before it */
    } else if (prev?.kind === "lineComment") {
      breakLine(depth > 0 ? depth : startsStatement || isClauseBreak(up, prev, next, stmtWords[0]) ? 0 : clause ? 1 : 0);
    } else if (isComment) {
      if (/\n/.test(before)) breakLine(depth > 0 ? depth : 0);
      else out += " ";
    } else if (startsStatement) {
      const blank = afterGo || prev?.text === ";" || (before.match(/\n/g)?.length ?? 0) >= 2 || multiline || stmtWords[0] !== up;
      out = `${out.replace(/\s+$/, "")}${blank ? "\n\n" : "\n"}`;
    } else if (depth === 0 && isClauseBreak(up, prev, next, stmtWords[0])) {
      breakLine(0);
    } else if (depth === 0 && (up === "ON" || ((up === "AND" || up === "OR") && !betweenPending)) && CONDITION_CLAUSES.has(clause)) {
      breakLine(1);
    } else if (columnList && depth === 1 && t.text === ")") {
      breakLine(0);
    } else if (atLineStart()) {
      /* just broke the line: no space */
    } else if (atLineStart()) {
      /* just broke the line: no space */
    } else if (before || (prev?.kind === "word" && (t.kind === "word" || t.kind === "number" || t.kind === "variable" || t.kind === "string"))) {
      out += " ";
    }

    afterGo = false;
    // State.
    if (startsStatement) {
      multiline = false;
      stmtWords = [];
      clause = "";
      columnList = false;
      statementEnded = false;
    }
    if (up && stmtWords.length < 3) stmtWords.push(up);
    if (depth === 0) {
      if (CLAUSE_STARTS.has(up)) clause = up === "UNION" || up === "EXCEPT" || up === "INTERSECT" ? "" : up;
      else if (JOIN_WORDS.has(up) && !(up === "LEFT" || up === "RIGHT" ? next?.text === "(" : false)) clause = "JOIN";
      if (up === "BETWEEN") betweenPending = true;
      else if (up === "AND") betweenPending = false;
    }

    out += t.kind === "word" && CASE_WORDS.has(up) && prev?.text !== "." && next?.text !== "." && !((up === "LEFT" || up === "RIGHT") && next?.text === "(") ? up : t.text;

    if (t.text === "(") {
      depth++;
      if (depth === 1 && stmtWords[0] === "CREATE" && stmtWords.includes("TABLE") && !columnList) {
        columnList = true;
        breakLine(1);
      }
    } else if (t.text === ")") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) columnList = false;
    } else if (t.text === "," && next && ((depth === 0 && LIST_CLAUSES.has(clause)) || (columnList && depth === 1))) {
      breakLine(1);
    } else if (t.text === ";") {
      statementEnded = true;
    }
    prev = t;
  }

  const result = out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  return { ok: true, text: `${result}\n` };
}

/** Whether the word at depth 0 begins a new top-level statement rather than continuing the current one. */
function startsNewStatement(up: string, prev: Tok | undefined, firstWord: string | undefined): boolean {
  if (!STARTERS.has(up)) return false;
  if (prev?.kind === "word" && CONTINUES.has(prev.text.toUpperCase())) return false;
  if ((up === "SELECT" || up === "EXEC" || up === "EXECUTE") && firstWord === "INSERT") return false;
  if (firstWord === "MERGE") return false;
  if (up === "UPDATE" && firstWord === "SELECT") return false;
  return true;
}

function isClauseBreak(up: string, prev: Tok | undefined, next: Tok | undefined, firstWord: string | undefined): boolean {
  if (!up) return false;
  const prevUp = prev?.kind === "word" ? prev.text.toUpperCase() : "";
  if (CLAUSE_STARTS.has(up)) {
    if (up === "SET" && firstWord !== "UPDATE") return false;
    if (up === "FROM" && firstWord === "DELETE" && prevUp === "DELETE") return false;
    if (up === "SELECT" && (prevUp === "UNION" || prevUp === "ALL" || prevUp === "EXCEPT" || prevUp === "INTERSECT")) return true;
    return true;
  }
  if (JOIN_WORDS.has(up)) {
    if ((up === "LEFT" || up === "RIGHT") && next?.text === "(") return false; // LEFT(...) is a function
    if (up === "OUTER" && !(next?.kind === "word" && next.text.toUpperCase() === "APPLY")) return false; // LEFT OUTER JOIN: LEFT already broke
    return !JOIN_WORDS.has(prevUp);
  }
  return false;
}
