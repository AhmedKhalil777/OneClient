/** Pure text helpers used by the autocomplete controller (kept DOM-free so they're unit-testable). */

/** Default word characters: letters, digits, `_`, plus `$`, `@`, `#` (SQL variables/temp tables, JS identifiers). */
export const DEFAULT_WORD_CHAR = /[\p{L}\p{N}_$@#]/u;

export function wordAt(text: string, offset: number, wordChar: RegExp = DEFAULT_WORD_CHAR): { start: number; prefix: string } {
  let start = offset;
  while (start > 0 && wordChar.test(text[start - 1]!)) start--;
  return { start, prefix: text.slice(start, offset) };
}

export function linePrefixAt(text: string, offset: number): string {
  return text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);
}

/**
 * Applies an accepted item: replaces `[wordStart, offset)` with `insertText`.
 * Returns the new text and where the caret goes (`$0` if present, else the end of the insert).
 */
export function applyCompletion(
  text: string,
  wordStart: number,
  offset: number,
  insertText: string,
): { text: string; insert: string; caret: number } {
  const marker = insertText.indexOf("$0");
  const insert = marker === -1 ? insertText : insertText.slice(0, marker) + insertText.slice(marker + 2);
  const caret = wordStart + (marker === -1 ? insert.length : marker);
  return { text: text.slice(0, wordStart) + insert + text.slice(offset), insert, caret };
}
