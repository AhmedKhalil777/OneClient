import type { TokenClass } from "@oneclient/plugin-api";

/** Only these class names are ever written into the markup — a plugin can't inject arbitrary attributes. */
const KNOWN_CLASSES = new Set<string>([
  "keyword",
  "string",
  "number",
  "comment",
  "type",
  "function",
  "operator",
  "variable",
  "property",
  "tag",
  "attribute",
  "punctuation",
  "heading",
  "strong",
  "emphasis",
  "link",
  "code",
  "quote",
  "list",
] satisfies TokenClass[]);

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Markup for the highlight layer drawn under the (transparent) textarea: the document text with each token
 * wrapped in `<span class="tok-…">`. Tokens that are out of order, overlapping or out of range are skipped.
 * The trailing newline+space keeps the layer exactly as tall as the textarea when the text ends with "\n".
 */
export function buildHighlightHtml(text: string, tokens: readonly number[], classes: readonly string[]): string {
  let out = "";
  let pos = 0;
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const s = tokens[i]!;
    const e = tokens[i + 1]!;
    const cls = classes[tokens[i + 2]!];
    if (s < pos || e <= s || e > text.length || !cls || !KNOWN_CLASSES.has(cls)) continue;
    out += `${escapeHtml(text.slice(pos, s))}<span class="tok-${cls}">${escapeHtml(text.slice(s, e))}</span>`;
    pos = e;
  }
  return `${out}${escapeHtml(text.slice(pos))}\n `;
}
