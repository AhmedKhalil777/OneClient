import type { DocumentSymbol, FileLens, LensesResult, SymbolsResult, TokenClass, TokensResult } from "@oneclient/plugin-api";

/**
 * `.http` / `.rest` files — the plain-text request format of VS Code's REST Client and JetBrains' HTTP Client:
 *
 *     @host = https://api.example.com
 *
 *     ### Log in
 *     # @name login
 *     POST {{host}}/login
 *     Content-Type: application/json
 *
 *     { "user": "ann", "password": "secret" }
 *
 *     ### Who am I
 *     GET {{host}}/me
 *     Authorization: Bearer {{login.response.body.$.token}}
 *
 * This module parses the file (requests, `@variables`, `# @name`, line positions), colors it, and lists its
 * requests as breadcrumb symbols and ▶ lenses. Sending lives in httpfile-run.ts.
 */

export interface HttpFileRequest {
  index: number;
  /** From `# @name login` — what other requests reference as `{{login.response…}}`. */
  name?: string | undefined;
  /** 0-based line of the request line, and of the last line of the block. */
  line: number;
  endLine: number;
  /** Offsets of the block in the document. */
  start: number;
  end: number;
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: string;
  /** `# @no-redirect`, `# @insecure` (accept self-signed certificates). */
  noRedirect: boolean;
  insecure: boolean;
  /** "GET https://…" — for lists and titles. */
  label: string;
}

export interface HttpFileVariable {
  name: string;
  value: string;
  line: number;
}

export interface ParsedHttpFile {
  variables: HttpFileVariable[];
  requests: HttpFileRequest[];
  tokens: number[];
}

export const TOKEN_CLASSES: TokenClass[] = ["keyword", "string", "comment", "variable", "property", "number", "operator"];
const [KEYWORD, STRING, COMMENT, VARIABLE, PROPERTY, NUMBER] = [0, 1, 2, 3, 4, 5];

const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT";
const REQUEST_LINE = new RegExp(`^(${METHODS})\\s+(\\S.*?)(?:\\s+(HTTP\\/[\\d.]+))?\\s*$`, "i");
const BARE_URL = /^(https?:\/\/\S+|\{\{[^}]+\}\}\S*)\s*$/i;
const SEPARATOR = /^\s*#{3,}/;
const COMMENT_LINE = /^\s*(#|\/\/)/;
const DIRECTIVE = /^\s*(?:#|\/\/)\s*@([\w-]+)(?:\s+(.*?))?\s*$/;
const FILE_VARIABLE = /^\s*@([^\s=]+)\s*=\s*(.*?)\s*$/;
const HEADER = /^\s*([^\s:][^:]*?)\s*:\s*(.*?)\s*$/;
const PLACEHOLDER = /\{\{[^{}\n]+\}\}/g;

type Span = [number, number, number];

/** Parses the file in one pass, collecting highlighting tokens as it goes. */
export function parseHttpFile(text: string): ParsedHttpFile {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + 1;
  }

  const variables: HttpFileVariable[] = [];
  const requests: HttpFileRequest[] = [];
  const tokens: number[] = [];

  /** Adds the spans of one line, cutting `{{variables}}` out of them so those get their own color. */
  const emit = (lineIndex: number, spans: Span[], paintVariables = true) => {
    const base = offsets[lineIndex]!;
    const line = lines[lineIndex]!;
    const vars: Array<[number, number]> = [];
    if (paintVariables) for (const m of line.matchAll(PLACEHOLDER)) vars.push([m.index!, m.index! + m[0].length]);
    const all: Span[] = [];
    for (const [s, e, c] of spans) {
      let cur = s;
      for (const [vs, ve] of vars) {
        if (ve <= cur || vs >= e) continue;
        if (vs > cur) all.push([cur, vs, c]);
        cur = Math.max(cur, ve);
      }
      if (cur < e) all.push([cur, e, c]);
    }
    for (const [vs, ve] of vars) all.push([vs, ve, VARIABLE]);
    all.sort((a, b) => a[0] - b[0]);
    for (const [s, e, c] of all) if (e > s) tokens.push(base + s, base + e, c);
  };

  // Block boundaries: the lines of `###`.
  const blocks: Array<{ from: number; to: number }> = [];
  let from = 0;
  for (let i = 0; i < lines.length; i++) {
    if (SEPARATOR.test(lines[i]!)) {
      blocks.push({ from, to: i - 1 });
      emit(i, [[0, lines[i]!.length, COMMENT]], false);
      from = i + 1;
    }
  }
  blocks.push({ from, to: lines.length - 1 });

  for (const block of blocks) {
    let i = block.from;
    let name: string | undefined;
    let noRedirect = false;
    let insecure = false;
    let requestLine = -1;

    // Before the request line: blanks, comments (with `# @name`), `@variables`.
    for (; i <= block.to; i++) {
      const raw = lines[i]!;
      if (!raw.trim()) continue;
      if (COMMENT_LINE.test(raw)) {
        emit(i, [[0, raw.length, COMMENT]], false);
        const d = DIRECTIVE.exec(raw);
        if (d?.[1] === "name" && d[2]) name = d[2].trim();
        else if (d?.[1] === "no-redirect") noRedirect = true;
        else if (d?.[1] === "insecure") insecure = true;
        continue;
      }
      const v = FILE_VARIABLE.exec(raw);
      if (v) {
        variables.push({ name: v[1]!, value: v[2]!, line: i });
        emit(i, [[raw.indexOf("@"), raw.indexOf("@") + 1 + v[1]!.length, VARIABLE]]);
        continue;
      }
      requestLine = i;
      break;
    }
    if (requestLine < 0) continue;

    // The request line (a bare URL means GET), then `?a=b` / `&c=d` continuation lines.
    const first = lines[requestLine]!;
    let method = "GET";
    let url: string;
    const m = REQUEST_LINE.exec(first.trim());
    const lead = first.length - first.trimStart().length;
    if (m) {
      method = m[1]!.toUpperCase();
      url = m[2]!;
      const mEnd = lead + m[1]!.length;
      const urlStart = first.indexOf(m[2]!, mEnd);
      emit(requestLine, [
        [lead, mEnd, KEYWORD],
        [urlStart, urlStart + m[2]!.length, STRING],
        ...(m[3] ? ([[first.lastIndexOf(m[3]), first.lastIndexOf(m[3]) + m[3].length, COMMENT]] as Span[]) : []),
      ]);
    } else if (BARE_URL.test(first.trim())) {
      url = first.trim();
      emit(requestLine, [[lead, lead + url.length, STRING]]);
    } else {
      // Not a request: keep scanning the rest of the block as plain text.
      emit(requestLine, []);
      continue;
    }
    i = requestLine + 1;
    while (i <= block.to && /^\s+[?&]/.test(lines[i]!)) {
      const piece = lines[i]!.trim();
      url += piece;
      emit(i, [[lines[i]!.indexOf(piece), lines[i]!.indexOf(piece) + piece.length, STRING]]);
      i++;
    }

    // Headers, up to the blank line.
    const headers: Array<[string, string]> = [];
    for (; i <= block.to; i++) {
      const raw = lines[i]!;
      if (!raw.trim()) break;
      if (COMMENT_LINE.test(raw)) {
        emit(i, [[0, raw.length, COMMENT]], false);
        continue;
      }
      const h = HEADER.exec(raw);
      if (!h) break;
      headers.push([h[1]!, h[2]!]);
      const at = raw.indexOf(h[1]!);
      emit(i, [[at, at + h[1]!.length, PROPERTY]]);
    }

    // The body: everything after the blank line, minus trailing blank lines.
    let bodyFrom = i;
    if (bodyFrom <= block.to && !lines[bodyFrom]!.trim()) bodyFrom++;
    let bodyTo = block.to;
    while (bodyTo >= bodyFrom && !lines[bodyTo]!.trim()) bodyTo--;
    const body = bodyFrom <= bodyTo ? lines.slice(bodyFrom, bodyTo + 1).join("\n") : "";
    for (let b = bodyFrom; b <= bodyTo; b++) emit(b, jsonSpans(lines[b]!));

    const end = block.to >= 0 ? offsets[block.to]! + lines[block.to]!.length : 0;
    requests.push({
      index: requests.length,
      name,
      line: requestLine,
      endLine: Math.max(requestLine, bodyTo >= requestLine ? bodyTo : i - 1),
      start: offsets[block.from]!,
      end,
      method,
      url,
      headers,
      body,
      noRedirect,
      insecure,
      label: `${method} ${url}`,
    });
  }

  // Tokens must ascend: blocks were visited in order, but the separator lines were emitted first.
  const sorted: number[] = [];
  const triples: Span[] = [];
  for (let k = 0; k < tokens.length; k += 3) triples.push([tokens[k]!, tokens[k + 1]!, tokens[k + 2]!]);
  triples.sort((a, b) => a[0] - b[0]);
  let last = 0;
  for (const [s, e, c] of triples) {
    if (s < last) continue;
    sorted.push(s, e, c);
    last = e;
  }
  return { variables, requests, tokens: sorted };
}

/** A light JSON coloring for body lines: keys, strings, numbers and literals. */
function jsonSpans(line: string): Span[] {
  const spans: Span[] = [];
  const re = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
  for (const m of line.matchAll(re)) {
    const s = m.index!;
    const t = m[0];
    if (t.startsWith('"')) spans.push([s, s + t.length, /^\s*:/.test(line.slice(s + t.length)) ? PROPERTY : STRING]);
    else if (/^-?\d/.test(t)) spans.push([s, s + t.length, NUMBER]);
    else spans.push([s, s + t.length, KEYWORD]);
  }
  return spans;
}

// ---- what the editor asks for -------------------------------------------------------------------------------------

export function httpFileTokens(text: string): TokensResult {
  return { ok: true, tokens: parseHttpFile(text).tokens, classes: TOKEN_CLASSES };
}

export function httpFileLenses(text: string): LensesResult {
  const lenses: FileLens[] = parseHttpFile(text).requests.map((r) => ({
    line: r.line,
    endLine: r.endLine,
    title: `Send Request${r.name ? ` (${r.name})` : ""}: ${r.label.length > 70 ? `${r.label.slice(0, 69)}…` : r.label}`,
    command: "http.file.run",
    args: { index: r.index },
  }));
  return { ok: true, lenses };
}

export function httpFileSymbols(text: string): SymbolsResult {
  const symbols: DocumentSymbol[] = parseHttpFile(text).requests.map((r) => ({
    name: r.name ?? r.label,
    ...(r.name ? { detail: r.label } : {}),
    kind: "other",
    start: r.start,
    end: r.end,
  }));
  return { ok: true, symbols };
}

// ---- paste a browser command, get a request ------------------------------------------------------------------------

/** A request in `.http` syntax, from a parsed command's pieces. */
export function toHttpFileRequest(r: { method: string; url: string; headers: Array<[string, string]>; body: string; name: string }): string {
  const lines = [`### ${r.name}`, `${r.method} ${r.url}`, ...r.headers.map(([k, v]) => `${k}: ${v}`)];
  if (r.body) lines.push("", r.body);
  return lines.join("\n");
}
