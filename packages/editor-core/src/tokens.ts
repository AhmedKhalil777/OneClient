import type { TokenClass, TokensResult } from "@oneclient/plugin-api";

/** The classes a tokenizer here can produce; a token's class is its index in this list (the editor's `classes` array). */
export const CLASSES: readonly TokenClass[] = ["keyword", "string", "number", "comment", "type", "function", "operator", "variable", "property", "tag", "attribute"];

export const KEYWORD = 0;
export const STRING = 1;
export const NUMBER = 2;
export const COMMENT = 3;
export const TYPE = 4;
export const FUNCTION = 5;
export const OPERATOR = 6;
export const VARIABLE = 7;
export const PROPERTY = 8;
export const TAG = 9;
export const ATTRIBUTE = 10;

/** Past this size a file is shown uncolored: highlighting runs on every edit and must stay instant. */
export const MAX_HIGHLIGHT_CHARS = 2_000_000;

/** Collects `[start, end, classIndex]` triples, keeping them ascending and non-overlapping (anything else is dropped). */
export class TokenBuilder {
  readonly out: number[] = [];
  private last = 0;

  push(start: number, end: number, cls: number): void {
    if (end <= start || start < this.last) return;
    this.out.push(start, end, cls);
    this.last = end;
  }

  result(): TokensResult {
    return { ok: true, tokens: this.out, classes: CLASSES };
  }
}

export const EMPTY: TokensResult = { ok: true, tokens: [], classes: CLASSES };

export const isDigit = (c: number) => c >= 48 && c <= 57;
export const isIdStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
export const isIdPart = (c: number) => isIdStart(c) || isDigit(c);
