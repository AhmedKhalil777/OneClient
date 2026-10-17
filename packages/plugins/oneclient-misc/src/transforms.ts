import type { TransformRequest, TransformResult } from "@oneclient/plugin-api";

/**
 * Line-oriented transforms. If the user has a selection they apply to the lines it touches,
 * otherwise to the whole document — the same convention as VS Code's "Sort Lines" commands.
 */
export function applyToLines(req: Pick<TransformRequest, "text" | "selection">, fn: (lines: string[]) => string[]): TransformResult {
  const { text, selection } = req;
  let from = 0;
  let to = text.length;
  if (selection && selection.end > selection.start) {
    from = text.lastIndexOf("\n", selection.start - 1) + 1;
    // A selection that ends right after a newline doesn't include the next line.
    const endOffset = selection.end > selection.start && text[selection.end - 1] === "\n" ? selection.end - 1 : selection.end;
    const nl = text.indexOf("\n", endOffset);
    to = nl === -1 ? text.length : nl;
  }
  const chunk = text.slice(from, to);
  const trailingNewline = chunk.endsWith("\n");
  const lines = (trailingNewline ? chunk.slice(0, -1) : chunk).split("\n");
  const next = fn(lines).join("\n") + (trailingNewline ? "\n" : "");
  return { ok: true, text: text.slice(0, from) + next + text.slice(to) };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const sortLinesAscending = (req: TransformRequest) => applyToLines(req, (lines) => [...lines].sort((a, b) => collator.compare(a, b)));
export const sortLinesDescending = (req: TransformRequest) => applyToLines(req, (lines) => [...lines].sort((a, b) => collator.compare(b, a)));

/** Keeps the first occurrence of each line (exact match), preserving order. */
export const removeDuplicateLines = (req: TransformRequest) =>
  applyToLines(req, (lines) => {
    const seen = new Set<string>();
    return lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  });

export const trimTrailingWhitespace = (req: TransformRequest) => applyToLines(req, (lines) => lines.map((l) => l.replace(/[ \t]+$/, "")));

/** Exactly one "\n" at the end of the file (none for an empty file). */
export function ensureFinalNewline(req: TransformRequest): TransformResult {
  const trimmed = req.text.replace(/\n+$/, "");
  return { ok: true, text: trimmed === "" ? "" : `${trimmed}\n` };
}
