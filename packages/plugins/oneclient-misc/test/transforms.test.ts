import { describe, expect, it } from "vitest";
import {
  ensureFinalNewline,
  removeDuplicateLines,
  sortLinesAscending,
  sortLinesDescending,
  trimTrailingWhitespace,
} from "../src/transforms.js";

const req = (text: string, selection?: { start: number; end: number }) => ({
  text,
  fileName: "a.txt",
  tabSize: 2,
  insertSpaces: true,
  ...(selection ? { selection } : {}),
});
const run = (fn: (r: ReturnType<typeof req>) => { ok: boolean; text?: string }, text: string, sel?: { start: number; end: number }) => {
  const r = fn(req(text, sel));
  if (!r.ok || r.text === undefined) throw new Error("transform failed");
  return r.text;
};

describe("sorting", () => {
  it("sorts the whole document, naturally and case-insensitively, keeping the final newline", () => {
    expect(run(sortLinesAscending, "b\nA\nitem10\nitem2\n")).toBe("A\nb\nitem2\nitem10\n");
    expect(run(sortLinesDescending, "b\nA\nc")).toBe("c\nb\nA");
  });

  it("sorts only the lines a selection touches", () => {
    const text = "z\nc\nb\na\ny";
    // selection somewhere inside "c" … "a"
    expect(run(sortLinesAscending, text, { start: 3, end: 7 })).toBe("z\na\nb\nc\ny");
  });

  it("doesn't include the next line when the selection ends right after a newline", () => {
    const text = "c\nb\na\nz";
    expect(run(sortLinesAscending, text, { start: 0, end: 6 })).toBe("a\nb\nc\nz"); // selected "c\nb\na\n"
  });
});

describe("removeDuplicateLines", () => {
  it("keeps the first of each line, in order", () => {
    expect(run(removeDuplicateLines, "a\nb\na\nc\nb\n")).toBe("a\nb\nc\n");
  });
});

describe("trimTrailingWhitespace", () => {
  it("trims spaces and tabs at line ends, not inside lines", () => {
    expect(run(trimTrailingWhitespace, "a  \n b c\t\n\n  d  ")).toBe("a\n b c\n\n  d");
  });
});

describe("ensureFinalNewline", () => {
  it("leaves exactly one newline", () => {
    expect(run(ensureFinalNewline, "a")).toBe("a\n");
    expect(run(ensureFinalNewline, "a\n\n\n")).toBe("a\n");
    expect(run(ensureFinalNewline, "")).toBe("");
    expect(run(ensureFinalNewline, "\n\n")).toBe("");
  });
});
