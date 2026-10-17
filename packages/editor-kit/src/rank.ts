import type { CompletionItem } from "@oneclient/plugin-api";
import { type FuzzyMatch, fuzzyMatch } from "./fuzzy.js";

export interface RankedItem {
  item: CompletionItem;
  match: FuzzyMatch;
}

/**
 * Filters items against what's typed and orders them: best fuzzy score
 * first, then `sortText`/label. Duplicate labels (e.g. the same word from
 * two providers) collapse to the first one seen.
 */
export function rankCompletions(items: readonly CompletionItem[], prefix: string, limit = 200): RankedItem[] {
  const seen = new Set<string>();
  const ranked: RankedItem[] = [];
  for (const item of items) {
    const key = `${item.kind ?? ""}\u0000${item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const match = fuzzyMatch(prefix, item.filterText ?? item.label);
    // Highlight positions refer to the label; if filterText differs, don't highlight.
    if (match) ranked.push({ item, match: item.filterText && item.filterText !== item.label ? { ...match, positions: [] } : match });
  }
  ranked.sort(
    (a, b) =>
      b.match.score - a.match.score ||
      (a.item.sortText ?? a.item.label).localeCompare(b.item.sortText ?? b.item.label, undefined, { sensitivity: "base" }),
  );
  return ranked.slice(0, limit);
}
