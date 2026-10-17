import { describe, expect, it } from "vitest";
import { sanitizeContributions } from "../src-ui/lib/contributions.js";
import { caretAfterReplace, diffEdit, lineOf, mapBack, mapForward, shiftTokens } from "../src-ui/lib/edit.js";
import { buildHighlightHtml } from "../src-ui/lib/highlight.js";
import { siblingsAt, symbolPath } from "../src-ui/lib/symbols.js";

describe("diffEdit / offset mapping", () => {
  it("finds the one changed region", () => {
    expect(diffEdit("hello world", "hello brave world")).toEqual({ start: 6, removed: 0, inserted: 6 });
    expect(diffEdit("abcdef", "abef")).toEqual({ start: 2, removed: 2, inserted: 0 });
    expect(diffEdit("abc", "abc")).toEqual({ start: 0, removed: 0, inserted: 0 });
    expect(diffEdit("", "x")).toEqual({ start: 0, removed: 0, inserted: 1 });
  });

  it("maps offsets across an insertion in both directions", () => {
    const e = diffEdit("ab|cd", "ab-XY-|cd"); // inserted "-XY-" at 2
    expect(mapForward(1, e)).toBe(1);
    expect(mapForward(4, e)).toBe(8); // after the insertion: shifted by 4
    expect(mapBack(8, e)).toBe(4);
    expect(mapBack(3, e)).toBe(2); // inside the inserted text → clamps to where it was inserted
  });

  it("clamps offsets inside a replaced region", () => {
    const e = { start: 5, removed: 4, inserted: 2 };
    expect(mapForward(7, e)).toBe(7);
    expect(mapForward(8, e)).toBe(7);
    expect(mapForward(9, e)).toBe(7);
    expect(mapForward(12, e)).toBe(10);
  });

  it("maps old→new→old to the same place outside the changed region", () => {
    const e = diffEdit("0123456789", "01XYZ789");
    for (const o of [0, 1, 2, 7, 8, 10]) expect(mapBack(mapForward(o, e), e)).toBe(o);
  });
});

describe("shiftTokens", () => {
  // tokens: [0,3) a, [4,7) b, [8,11) c
  const tokens = [0, 3, 0, 4, 7, 1, 8, 11, 2];

  it("keeps tokens before the edit and shifts the ones after", () => {
    expect(shiftTokens(tokens, { start: 3, removed: 0, inserted: 2 })).toEqual([0, 3, 0, 6, 9, 1, 10, 13, 2]);
  });

  it("drops tokens the edit touches", () => {
    expect(shiftTokens(tokens, { start: 5, removed: 1, inserted: 3 })).toEqual([0, 3, 0, 10, 13, 2]);
  });

  it("is a no-op for an unchanged text", () => {
    expect(shiftTokens(tokens, { start: 0, removed: 0, inserted: 0 })).toEqual(tokens);
  });
});

describe("caretAfterReplace", () => {
  it("keeps the caret after the same non-whitespace characters when only whitespace changes", () => {
    const before = '{"a":1,"b":2}';
    const after = '{\n  "a": 1,\n  "b": 2\n}';
    const caret = before.indexOf('"b"') + 2; // inside "b"
    const pos = caretAfterReplace(before, caret, after);
    expect(after.slice(0, pos).replace(/\s/g, "")).toBe(before.slice(0, caret).replace(/\s/g, ""));
    expect(after[pos - 1]).toBe("b");
  });

  it("handles the start and the end of the document", () => {
    expect(caretAfterReplace("  a", 0, "a")).toBe(0);
    expect(caretAfterReplace("a b", 3, "a\nb\n")).toBe(3);
  });
});

describe("lineOf", () => {
  it("counts newlines before an offset", () => {
    expect(lineOf("a\nb\nc", 0)).toBe(0);
    expect(lineOf("a\nb\nc", 2)).toBe(1);
    expect(lineOf("a\nb\nc", 99)).toBe(2);
  });
});

describe("buildHighlightHtml", () => {
  it("wraps tokens, escapes everything and ends with a spacer line", () => {
    const html = buildHighlightHtml('<a b="1">', [1, 2, 0, 3, 8, 1], ["tag", "string"]);
    expect(html).toBe('&lt;<span class="tok-tag">a</span> <span class="tok-string">b="1"</span>&gt;\n ');
  });

  it("skips overlapping, out-of-range and unknown-class tokens, and never lets a class name inject markup", () => {
    const html = buildHighlightHtml("abcdef", [0, 3, 0, 2, 4, 0, 4, 99, 0, 3, 5, 1, 5, 6, 2], ["keyword", 'x" onmouseover="evil', "string"]);
    expect(html).toBe('<span class="tok-keyword">abc</span>de<span class="tok-string">f</span>\n ');
  });
});

describe("symbolPath / siblingsAt", () => {
  const symbols = [
    { name: "a", kind: "object" as const, start: 0, end: 20, children: [{ name: "x", kind: "string" as const, start: 2, end: 8 }, { name: "y", kind: "object" as const, start: 9, end: 19, children: [{ name: "z", kind: "number" as const, start: 11, end: 15 }] }] },
    { name: "b", kind: "object" as const, start: 20, end: 30 },
  ];

  it("returns the chain of symbols around the cursor, outermost first", () => {
    expect(symbolPath(symbols, 12).map((s) => s.name)).toEqual(["a", "y", "z"]);
    expect(symbolPath(symbols, 3).map((s) => s.name)).toEqual(["a", "x"]);
    expect(symbolPath(symbols, 9).map((s) => s.name)).toEqual(["a", "y"]);
    expect(symbolPath(symbols, 1).map((s) => s.name)).toEqual(["a"]);
  });

  it("prefers the later symbol at a shared boundary, and includes the very end of the last one", () => {
    expect(symbolPath(symbols, 20).map((s) => s.name)).toEqual(["b"]);
    expect(symbolPath(symbols, 30).map((s) => s.name)).toEqual(["b"]);
    expect(symbolPath(symbols, 31)).toEqual([]);
  });

  it("lists the alternatives for each breadcrumb segment", () => {
    const path = symbolPath(symbols, 12);
    expect(siblingsAt(symbols, path, 0).map((s) => s.name)).toEqual(["a", "b"]);
    expect(siblingsAt(symbols, path, 1).map((s) => s.name)).toEqual(["x", "y"]);
    expect(siblingsAt(symbols, path, 2).map((s) => s.name)).toEqual(["z"]);
  });
});

describe("sanitizeContributions", () => {
  it("keeps well-formed contributions and drops malformed fields and entries", () => {
    const out = sanitizeContributions([
      { id: "json", label: "JSON", pluginId: "p", extensions: ["json", 3, "jsonc"], format: "json.format", previewByDefault: "yes", evil: "x", actions: [{ id: "a", label: "A", command: "c" }, { id: "bad" }] },
      { id: "no-label", pluginId: "p" },
      { label: "no id", pluginId: "p" },
      { id: "x", label: "X" }, // no pluginId
    ]);
    expect(out).toEqual([
      { id: "json", label: "JSON", pluginId: "p", extensions: ["json", "jsonc"], format: "json.format", actions: [{ id: "a", label: "A", command: "c" }] },
    ]);
  });
});
