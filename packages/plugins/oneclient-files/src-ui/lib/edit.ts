/**
 * Offset bookkeeping between two versions of the document.
 *
 * Language features (tokens, symbols) are computed for a snapshot of the text and arrive a moment after
 * the user typed again. Instead of drawing them misaligned (or flickering back to plain text) the editor
 * keeps them and *shifts* them across the edit that happened since — the same trick real editors use.
 */

/** The single contiguous region that differs between two texts: `removed` chars at `start` became `inserted` chars. */
export interface TextEdit {
  start: number;
  removed: number;
  inserted: number;
}

export function diffEdit(prev: string, next: string): TextEdit {
  if (prev === next) return { start: 0, removed: 0, inserted: 0 };
  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  return { start, removed: endPrev - start, inserted: endNext - start };
}

/** An offset in the old text → the same spot in the new text. Offsets inside the changed region clamp into it. */
export function mapForward(offset: number, e: TextEdit): number {
  if (offset <= e.start) return offset;
  if (offset >= e.start + e.removed) return offset + e.inserted - e.removed;
  return e.start + Math.min(offset - e.start, e.inserted);
}

/** An offset in the new text → the same spot in the old text. */
export function mapBack(offset: number, e: TextEdit): number {
  if (offset <= e.start) return offset;
  if (offset >= e.start + e.inserted) return offset - e.inserted + e.removed;
  return e.start + Math.min(offset - e.start, e.removed);
}

/** Flat `[start, end, class, …]` tokens moved across `edit`; tokens touching the changed region are dropped until fresh ones arrive. */
export function shiftTokens(tokens: readonly number[], e: TextEdit): number[] {
  if (e.removed === 0 && e.inserted === 0) return tokens as number[];
  const delta = e.inserted - e.removed;
  const out: number[] = [];
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const s = tokens[i]!;
    const end = tokens[i + 1]!;
    if (end <= e.start) out.push(s, end, tokens[i + 2]!);
    else if (s >= e.start + e.removed) out.push(s + delta, end + delta, tokens[i + 2]!);
  }
  return out;
}

/**
 * Where the caret should land after the whole document was replaced by a reformatted version: after the same
 * number of non-whitespace characters. Right for formatters that only move whitespace around; a fair
 * guess for ones that reorder lines.
 */
export function caretAfterReplace(oldText: string, oldCaret: number, newText: string): number {
  let target = 0;
  for (let i = 0; i < Math.min(oldCaret, oldText.length); i++) if (!/\s/.test(oldText[i]!)) target++;
  if (target === 0) return 0;
  let seen = 0;
  for (let i = 0; i < newText.length; i++) {
    if (!/\s/.test(newText[i]!) && ++seen === target) return i + 1;
  }
  return newText.length;
}

/** Number of lines before `offset` (0-based line of the offset). */
export function lineOf(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
