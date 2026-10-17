import { describe, expect, it } from "vitest";
import { formatJson, jsonSymbols, jsonTokens, minifyJson } from "../src/json.js";

describe("formatJson", () => {
  it("pretty-prints minified JSON with the requested indentation", () => {
    const r = formatJson('{"a":1,"b":[1,2,{"c":null}],"d":{}}', 2, true);
    expect(r).toEqual({
      ok: true,
      text: '{\n  "a": 1,\n  "b": [\n    1,\n    2,\n    {\n      "c": null\n    }\n  ],\n  "d": {}\n}',
    });
  });

  it("uses tabs when asked", () => {
    expect(formatJson('{"a":{"b":1}}', 4, false)).toEqual({ ok: true, text: '{\n\t"a": {\n\t\t"b": 1\n\t}\n}' });
  });

  it("keeps comments and trailing commas (JSONC), and the file's final newline state", () => {
    const r = formatJson('// settings\n{"a":1, /* why */ "b":2,}\n', 2, true);
    expect(r.ok && r.text).toBe('// settings\n{\n  "a": 1, /* why */\n  "b": 2,\n}\n');
  });

  it("is idempotent", () => {
    const once = formatJson('{"a":[1,2],"b":{"c":"d"}}', 2, true);
    expect(once.ok).toBe(true);
    if (once.ok) expect(formatJson(once.text, 2, true)).toEqual(once);
  });

  it("refuses broken JSON, pointing at the problem", () => {
    const r = formatJson('{"a": 1 "b": 2}', 2, true);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/^Can't format:/);
      expect(r.error.offset).toBe(8);
    }
  });

  it("leaves an empty document alone", () => {
    expect(formatJson("  \n", 2, true)).toEqual({ ok: true, text: "  \n" });
  });
});

describe("minifyJson", () => {
  it("removes whitespace and comments but keeps literals exactly", () => {
    const r = minifyJson('{\n  "big": 12345678901234567890, // keep digits\n  "s": "a  b",\n  "e": 1.50e+2\n}\n');
    expect(r).toEqual({ ok: true, text: '{"big":12345678901234567890,"s":"a  b","e":1.50e+2}\n' });
  });

  it("drops trailing commas without touching strings that look like them", () => {
    const r = minifyJson('{"a":[1,2,],"b":"x,}",}');
    expect(r).toEqual({ ok: true, text: '{"a":[1,2],"b":"x,}"}' });
  });

  it("refuses invalid JSON", () => {
    expect(minifyJson("{").ok).toBe(false);
  });
});

describe("jsonSymbols", () => {
  const text = '{\n  "name": "demo",\n  "scripts": { "build": "tsc" },\n  "items": [ { "id": "x", "n": 1 }, 2 ]\n}';
  const result = jsonSymbols(text);

  it("nests properties and array items like the document", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.symbols.map((s) => s.name)).toEqual(["name", "scripts", "items"]);
    const items = result.symbols[2]!;
    expect(items.kind).toBe("array");
    expect(items.detail).toBe("2 items");
    expect(items.children?.map((c) => c.name)).toEqual(["[0]", "[1]"]);
    expect(items.children?.[0]?.children?.map((c) => c.name)).toEqual(["id", "n"]);
  });

  it("describes values briefly so breadcrumbs are readable", () => {
    if (!result.ok) throw new Error("unreachable");
    expect(result.symbols[0]).toMatchObject({ name: "name", kind: "string", detail: '"demo"' });
    expect(result.symbols[2]!.children![0]).toMatchObject({ detail: '"x"' }); // object identified by its "id"
    expect(result.symbols[2]!.children![1]).toMatchObject({ kind: "number", detail: "2" });
  });

  it("gives ranges that contain the value, so the cursor path can be found by offset", () => {
    if (!result.ok) throw new Error("unreachable");
    const build = result.symbols[1]!.children![0]!;
    expect(text.slice(build.start, build.end)).toBe('"build": "tsc"');
    const arrayItem = result.symbols[2]!.children![0]!;
    expect(text.slice(arrayItem.start, arrayItem.end)).toBe('{ "id": "x", "n": 1 }');
  });

  it("reports a syntax error but still returns what it could parse", () => {
    const r = jsonSymbols('{"a": {"b": 1, "c": }, "d": 2}');
    expect(r.ok && r.error?.message).toBeTruthy();
    expect(r.ok && r.symbols.map((s) => s.name)).toContain("a");
  });

  it("handles scalars and empty input", () => {
    expect(jsonSymbols("42")).toEqual({ ok: true, symbols: [] });
    expect(jsonSymbols("")).toEqual({ ok: true, symbols: [] });
  });
});

describe("scanner token kinds", () => {
  it("match the numbers json.ts hard-codes", async () => {
    // If jsonc-parser ever renumbers SyntaxKind, highlighting and minify would silently break — fail loudly instead.
    const { createScanner } = await import("jsonc-parser");
    const kinds = (text: string, ignoreTrivia = false) => {
      const s = createScanner(text, ignoreTrivia);
      const out: number[] = [];
      for (let k = s.scan(); k !== 17; k = s.scan()) out.push(k);
      return out;
    };
    // { } [ ] , : null true false "s" 1 // c /* c */ ⏎ ␠ then EOF=17
    expect(kinds('{}[],:null true false "s" 1 // c\n/* c */')).toEqual([1, 2, 3, 4, 5, 6, 7, 15, 8, 15, 9, 15, 10, 15, 11, 15, 12, 14, 13]);
  });
});

describe("jsonTokens", () => {
  it("separates property names from string values and colors literals and comments", () => {
    const text = '{"k": "v", "n": -1.5, "t": true, "z": null} // end';
    const r = jsonTokens(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const toks: Array<[string, string]> = [];
    for (let i = 0; i < r.tokens.length; i += 3) {
      toks.push([r.classes[r.tokens[i + 2]!]!, text.slice(r.tokens[i], r.tokens[i + 1])]);
    }
    expect(toks).toEqual([
      ["property", '"k"'],
      ["string", '"v"'],
      ["property", '"n"'],
      ["number", "-1.5"],
      ["property", '"t"'],
      ["keyword", "true"],
      ["property", '"z"'],
      ["keyword", "null"],
      ["comment", "// end"],
    ]);
  });

  it("keeps token offsets ascending", () => {
    const r = jsonTokens('{"a":[1,"b",{"c":false}]}');
    if (!r.ok) throw new Error("unreachable");
    const starts = r.tokens.filter((_, i) => i % 3 === 0);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
