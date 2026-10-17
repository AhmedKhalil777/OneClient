import type { DocumentSymbol } from "@oneclient/plugin-api";

/**
 * The chain of symbols containing `offset`, outermost first — the breadcrumb path
 * (`root › users › [3] › name`). At a boundary the later symbol wins, so a cursor at the very start
 * of the next Markdown section is in that section.
 */
export function symbolPath(symbols: readonly DocumentSymbol[], offset: number): DocumentSymbol[] {
  const path: DocumentSymbol[] = [];
  let level: readonly DocumentSymbol[] = symbols;
  for (;;) {
    const hit =
      level.find((s) => offset >= s.start && offset < s.end) ?? level.find((s) => offset >= s.start && offset <= s.end);
    if (!hit) return path;
    path.push(hit);
    level = hit.children ?? [];
  }
}

/** Symbols that can replace `path[index]` in the breadcrumb: its siblings (or the roots for the first segment). */
export function siblingsAt(symbols: readonly DocumentSymbol[], path: readonly DocumentSymbol[], index: number): readonly DocumentSymbol[] {
  return index === 0 ? symbols : (path[index - 1]?.children ?? []);
}
