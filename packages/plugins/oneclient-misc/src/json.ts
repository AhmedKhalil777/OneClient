import {
  type Node,
  type ParseError,
  type ParseOptions,
  type SyntaxKind,
  applyEdits,
  createScanner,
  format,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";
import type { DocumentSymbol, FileEditorError, SymbolsResult, TokenClass, TokensResult, TransformResult } from "@oneclient/plugin-api";

/**
 * jsonc-parser's token kinds. It declares `SyntaxKind` as an ambient const enum, which can't be referenced by
 * value under `isolatedModules`, so the (stable, documented) numbers are repeated here; json.test.ts checks
 * them against real scanner output.
 */
const K = {
  CloseBrace: 2,
  CloseBracket: 4,
  Comma: 5,
  Colon: 6,
  Null: 7,
  True: 8,
  False: 9,
  String: 10,
  Number: 11,
  LineComment: 12,
  BlockComment: 13,
  LineBreak: 14,
  Trivia: 15,
  EOF: 17,
} as const;

/**
 * Comments and trailing commas are accepted everywhere (tsconfig.json, .eslintrc, VS Code settings…),
 * so only real syntax errors count as problems.
 */
const PARSE_OPTIONS: ParseOptions = { allowTrailingComma: true, allowEmptyContent: true };

function firstError(errors: ParseError[]): FileEditorError | undefined {
  const e = errors[0];
  return e ? { message: printParseErrorCode(e.error), offset: e.offset } : undefined;
}

/** "Format Document": pretty-print with the editor's indentation, keeping comments. */
export function formatJson(text: string, tabSize: number, insertSpaces: boolean): TransformResult {
  if (text.trim() === "") return { ok: true, text };
  const errors: ParseError[] = [];
  parseTree(text, errors, PARSE_OPTIONS);
  const error = firstError(errors);
  if (error) return { ok: false, error: { ...error, message: `Can't format: ${error.message}` } };
  const edits = format(text, undefined, { tabSize, insertSpaces, eol: "\n", insertFinalNewline: text.endsWith("\n") });
  return { ok: true, text: applyEdits(text, edits) };
}

/**
 * Minify: drop whitespace and comments by re-joining the scanner's tokens, so every literal
 * (large integers, escapes, number formats) comes out exactly as written.
 */
export function minifyJson(text: string): TransformResult {
  const errors: ParseError[] = [];
  parseTree(text, errors, PARSE_OPTIONS);
  const error = firstError(errors);
  if (error) return { ok: false, error: { ...error, message: `Can't minify: ${error.message}` } };
  const scanner = createScanner(text, true); // ignoreTrivia: whitespace, newlines and comments never come back
  const pieces: Array<{ kind: SyntaxKind; text: string }> = [];
  for (let kind = scanner.scan(); kind !== K.EOF; kind = scanner.scan()) {
    pieces.push({ kind, text: text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()) });
  }
  // Trailing commas ("[1,]") are legal in JSONC but not in JSON — a minified file is usually meant for machines.
  // Decided per token, so a string like "a,}" is never touched.
  const isClose = (k: SyntaxKind | undefined) => k === K.CloseBrace || k === K.CloseBracket;
  const out = pieces
    .filter((p, i) => !(p.kind === K.Comma && isClose(pieces[i + 1]?.kind)))
    .map((p) => p.text)
    .join("");
  return { ok: true, text: text.endsWith("\n") ? `${out}\n` : out };
}

// ---- Document symbols (breadcrumbs) ----------------------------------------------------------------------------

const MAX_SYMBOLS = 20_000;
const MAX_DETAIL = 40;
/** Properties whose string value says which object this is — shown next to "[3]" in breadcrumbs. */
const IDENTIFYING_KEYS = ["name", "id", "title", "key", "label", "type"];

function clip(s: string): string {
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL - 1)}…` : s;
}

function detailOf(value: Node): string | undefined {
  switch (value.type) {
    case "string":
      return clip(JSON.stringify(value.value));
    case "number":
    case "boolean":
      return String(value.value);
    case "null":
      return "null";
    case "array":
      return `${value.children?.length ?? 0} item${value.children?.length === 1 ? "" : "s"}`;
    case "object": {
      for (const key of IDENTIFYING_KEYS) {
        const prop = value.children?.find((p) => p.children?.[0]?.value === key);
        const v = prop?.children?.[1];
        if (v?.type === "string") return clip(JSON.stringify(v.value));
      }
      return `${value.children?.length ?? 0} key${value.children?.length === 1 ? "" : "s"}`;
    }
    default:
      return undefined;
  }
}

function symbolFor(name: string, value: Node, range: { offset: number; length: number }, budget: { left: number }): DocumentSymbol {
  const kind = value.type === "property" ? "property" : value.type;
  const detail = detailOf(value);
  const children = budget.left > 0 ? childSymbols(value, budget) : [];
  return {
    name,
    ...(detail !== undefined ? { detail } : {}),
    kind: kind === "object" || kind === "array" || kind === "string" || kind === "number" || kind === "boolean" || kind === "null" ? kind : "other",
    start: range.offset,
    end: range.offset + range.length,
    ...(children.length ? { children } : {}),
  };
}

function childSymbols(node: Node, budget: { left: number }): DocumentSymbol[] {
  const out: DocumentSymbol[] = [];
  if (node.type === "object") {
    for (const prop of node.children ?? []) {
      if (--budget.left < 0) break;
      const [key, value] = prop.children ?? [];
      if (!key) continue;
      const name = String(key.value);
      out.push(value ? symbolFor(name, value, prop, budget) : { name, kind: "property", start: prop.offset, end: prop.offset + prop.length });
    }
  } else if (node.type === "array") {
    (node.children ?? []).forEach((item, i) => {
      if (--budget.left < 0) return;
      out.push(symbolFor(`[${i}]`, item, item, budget));
    });
  }
  return out;
}

/** The document's structure: object properties and array items, nested like the JSON itself. */
export function jsonSymbols(text: string): SymbolsResult {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, PARSE_OPTIONS);
  const error = firstError(errors);
  const symbols = root ? childSymbols(root, { left: MAX_SYMBOLS }) : [];
  return { ok: true, symbols, ...(error ? { error } : {}) };
}

// ---- Syntax highlighting -----------------------------------------------------------------------------------------

const CLASSES: TokenClass[] = ["property", "string", "number", "keyword", "comment"];
const [PROPERTY, STRING, NUMBER, KEYWORD, COMMENT] = [0, 1, 2, 3, 4];

export function jsonTokens(text: string): TokensResult {
  const scanner = createScanner(text, false);
  const raw: Array<{ kind: SyntaxKind; start: number; end: number }> = [];
  for (let kind = scanner.scan(); kind !== K.EOF; kind = scanner.scan()) {
    raw.push({ kind, start: scanner.getTokenOffset(), end: scanner.getTokenOffset() + scanner.getTokenLength() });
  }
  const tokens: number[] = [];
  const isTrivia = (k: SyntaxKind) => k === K.Trivia || k === K.LineBreak || k === K.LineComment || k === K.BlockComment;
  raw.forEach((t, i) => {
    switch (t.kind as number) {
      case K.String: {
        // A string followed (past trivia) by ":" is a property name.
        let j = i + 1;
        while (j < raw.length && isTrivia(raw[j]!.kind)) j++;
        tokens.push(t.start, t.end, raw[j]?.kind === K.Colon ? PROPERTY : STRING);
        break;
      }
      case K.Number:
        tokens.push(t.start, t.end, NUMBER);
        break;
      case K.True:
      case K.False:
      case K.Null:
        tokens.push(t.start, t.end, KEYWORD);
        break;
      case K.LineComment:
      case K.BlockComment:
        tokens.push(t.start, t.end, COMMENT);
        break;
      default:
        break;
    }
  });
  return { ok: true, tokens, classes: CLASSES };
}
