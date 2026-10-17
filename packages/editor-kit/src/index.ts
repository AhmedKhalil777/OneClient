/**
 * @oneclient/editor-kit — shared editor building blocks for plugin Tier 2
 * views. Source-only workspace package: plugin UIs import it and their
 * bundler (Vite) compiles it in, so there's no separate build step.
 *
 *   import { attachAutocomplete, wordsProvider } from "@oneclient/editor-kit";
 *   import { useAutocomplete } from "@oneclient/editor-kit/react";
 */
export { attachAutocomplete, type AutocompleteHandle, type AutocompleteOptions } from "./autocomplete.js";
export { wordsProvider } from "./providers/words.js";
export { fuzzyMatch, type FuzzyMatch } from "./fuzzy.js";
export { rankCompletions, type RankedItem } from "./rank.js";
export { applyCompletion, wordAt, linePrefixAt, DEFAULT_WORD_CHAR } from "./text.js";
export type { CompletionContext, CompletionItem, CompletionItemKind, CompletionProvider } from "@oneclient/plugin-api";
