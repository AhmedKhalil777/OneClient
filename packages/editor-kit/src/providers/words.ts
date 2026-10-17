import type { CompletionItem, CompletionProvider } from "@oneclient/plugin-api";

/**
 * VS Code's default "word-based suggestions": every distinct word already in
 * the document (except the one being typed). Works for any text format, so
 * it's a good fallback provider to put last.
 */
export function wordsProvider(options: { minLength?: number; maxWords?: number } = {}): CompletionProvider {
  const minLength = options.minLength ?? 3;
  const maxWords = options.maxWords ?? 5000;
  return {
    provideCompletions({ text, wordStart, offset }) {
      // Skip the word under the caret so it doesn't suggest itself.
      const before = text.slice(0, wordStart);
      const after = text.slice(offset).replace(/^[\p{L}\p{N}_$]*/u, "");
      const words = new Set<string>();
      for (const m of `${before} ${after}`.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu)) {
        if (m[0].length >= minLength) words.add(m[0]);
        if (words.size >= maxWords) break;
      }
      return [...words].map((label): CompletionItem => ({ label, kind: "text", sortText: `~${label}` }));
    },
  };
}
