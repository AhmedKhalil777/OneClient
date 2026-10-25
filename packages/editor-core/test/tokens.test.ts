import { describe, expect, it } from "vitest";
import type { TokensResult } from "@oneclient/plugin-api";
import { csharpTokens, cssTokens, javascriptTokens, typescriptTokens, yamlTokens } from "../src/index.js";

/** `class:text` for every token, in order. */
function show(text: string, r: TokensResult): string[] {
  if (!r.ok) throw new Error("not ok");
  const out: string[] = [];
  for (let i = 0; i < r.tokens.length; i += 3) out.push(`${r.classes[r.tokens[i + 2]!]}:${text.slice(r.tokens[i], r.tokens[i + 1])}`);
  return out;
}
const ts = (t: string) => show(t, typescriptTokens(t));
const js = (t: string) => show(t, javascriptTokens(t));
const cs = (t: string) => show(t, csharpTokens(t));
const css = (t: string, lineComments = false) => show(t, cssTokens(t, lineComments));

function ascending(r: TokensResult) {
  if (!r.ok) throw new Error("not ok");
  let last = 0;
  for (let i = 0; i < r.tokens.length; i += 3) {
    expect(r.tokens[i]!).toBeGreaterThanOrEqual(last);
    expect(r.tokens[i + 1]!).toBeGreaterThan(r.tokens[i]!);
    last = r.tokens[i + 1]!;
  }
}

describe("typescript", () => {
  it("colors keywords, types, calls, strings, numbers and comments", () => {
    expect(ts('const x: number = foo(1.5e3, "a"); // hi')).toEqual(["keyword:const", "type:number", "function:foo", "number:1.5e3", 'string:"a"', "comment:// hi"]);
  });
  it("knows class names, members, decorators and generics", () => {
    const t = ts("@Component({}) export class Foo extends Bar<string> { private name: Promise<void>; run() { this.items.push(1); } }");
    expect(t).toContain("attribute:@Component");
    expect(t).toContain("type:Foo");
    expect(t).toContain("type:Bar");
    expect(t).toContain("type:string");
    expect(t).toContain("type:Promise");
    expect(t).toContain("keyword:private");
    expect(t).toContain("function:run");
    expect(t).toContain("property:items");
    expect(t).toContain("function:push");
  });
  it("handles template literals with nested expressions", () => {
    expect(ts("const s = `a ${b + `x${c}y`} d`;")).toEqual(["keyword:const", "string:`a ", "string:`x", "string:y`", "string: d`"]);
  });
  it("tells a regex from a division", () => {
    expect(js("const r = /a[/]b/gi; const q = a / b / c;")).toEqual(["keyword:const", "string:/a[/]b/gi", "keyword:const"]);
  });
  it("colors JSX tags only when asked", () => {
    const t = "return <Button onClick={f}>x</Button>;";
    expect(show(t, typescriptTokens(t, true))).toContain("tag:Button");
    expect(show(t, typescriptTokens(t, false))).not.toContain("tag:Button");
  });
  it("survives unterminated input and keeps tokens ordered", () => {
    for (const src of ['const a = "abc', "/* open", "`a ${b", "x = /re", "}}} ${ ` ` `"]) ascending(typescriptTokens(src));
  });
});

describe("javascript", () => {
  it("colors a plain function", () => {
    expect(js("function add(a, b) { return a + b; }")).toEqual(["keyword:function", "function:add", "keyword:return"]);
  });
});

describe("csharp", () => {
  it("colors usings, types, attributes and members", () => {
    const src = [
      "using System;",
      "namespace App {",
      "  [Serializable]",
      "  public class Foo : Base {",
      "    public int Count { get; set; }",
      '    public void Run() { Console.WriteLine("hi"); }',
      "  }",
      "}",
    ].join("\n");
    const t = cs(src);
    expect(t).toContain("keyword:using");
    expect(t).toContain("type:System");
    expect(t).toContain("attribute:Serializable");
    expect(t).toContain("type:Foo");
    expect(t).toContain("type:int");
    expect(t).toContain("keyword:get");
    expect(t).toContain("function:Run");
    expect(t).toContain("type:Console");
    expect(t).toContain("function:WriteLine");
    expect(t).toContain('string:"hi"');
  });
  it("handles verbatim, interpolated and raw strings and char literals", () => {
    const src = 'var a = @"c:\\x ""q"" \n z"; var b = $"v {x}"; var c = """raw "q" """; var d = \'\\n\';';
    expect(cs(src).filter((x) => x.startsWith("string:"))).toEqual(['string:@"c:\\x ""q"" \n z"', 'string:$"v {x}"', 'string:"""raw "q" """', "string:'\\n'"]);
  });
  it("colors preprocessor directives and verbatim identifiers", () => {
    const t = cs("#region Foo\nvar @class = 1;\n#endregion");
    expect(t).toContain("keyword:#region");
    expect(t).toContain("keyword:#endregion");
    expect(t).toContain("number:1");
    expect(t).not.toContain("keyword:@class");
  });
});

describe("css", () => {
  it("colors selectors, properties, values and comments", () => {
    const src = '/* c */ a.btn:hover > #id[type="x"] { color: #fff; margin: -1.5rem 0 !important; background: url("a.png"); --gap: 4px; width: calc(100% - var(--gap)); }';
    const t = css(src);
    expect(t).toContain("comment:/* c */");
    expect(t).toContain("tag:a");
    expect(t).toContain("type:.btn");
    expect(t).toContain("keyword::hover");
    expect(t).toContain("variable:#id");
    expect(t).toContain("attribute:type");
    expect(t).toContain('string:"x"');
    expect(t).toContain("property:color");
    expect(t).toContain("number:#fff");
    expect(t).toContain("number:-1.5rem");
    expect(t).toContain("keyword:!important");
    expect(t).toContain("function:url");
    expect(t).toContain("variable:--gap");
    expect(t).toContain("function:calc");
    expect(t).toContain("number:100%");
    expect(t).toContain("function:var");
  });
  it("handles at-rules and nesting", () => {
    const t = css("@media (min-width: 600px) and (max-width: 900px) { .a { &:hover { color: red } } }");
    expect(t).toContain("keyword:@media");
    expect(t).toContain("property:min-width");
    expect(t).toContain("keyword:and");
    expect(t).toContain("number:600px");
    expect(t).toContain("type:.a");
    expect(t).toContain("keyword::hover");
    expect(t).toContain("property:color");
  });
  it("accepts // comments only for SCSS/Less", () => {
    expect(css("// x\n.a { b: c }", true)).toContain("comment:// x");
    expect(css("// x\n.a { b: c }", false)).not.toContain("comment:// x");
  });
  it("survives unterminated input", () => {
    for (const src of ["a { color: ", "/* open", 'a[href="x', "@media (", "}}}{{{;;"]) ascending(cssTokens(src));
  });
});

describe("performance", () => {
  it("tokenizes a large file quickly", () => {
    const line = "export const value: Record<string, number> = { a: 1, b: `x${y}` }; // note\n";
    const text = line.repeat(40_000);
    const t0 = performance.now();
    typescriptTokens(text);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("yaml", () => {
  const y = (t: string) => show(t, yamlTokens(t));
  it("colors keys, values, comments and markers", () => {
    const src = ["# top", "---", "name: app # trailing", "version: 1.5", "enabled: true", 'title: "a: b"', "items:", "  - id: 7", "    tags: [a, b]", "  - &anc x", "ref: *anc", "map: {k: 1, 'q': two}"].join("\n");
    const t = y(src);
    expect(t).toEqual([
      "comment:# top", "keyword:---", "property:name", "comment:# trailing", "property:version", "number:1.5", "property:enabled", "keyword:true",
      "property:title", 'string:"a: b"', "property:items", "property:id", "number:7", "property:tags", "variable:&anc", "property:ref", "variable:*anc",
      "property:map", "property:k", "number:1", "property:'q'",
    ]);
  });
  it("colors block scalars as strings", () => {
    const t = y("run: |\n  echo hi: there\n  # not a comment\nnext: 1");
    expect(t).toEqual(["property:run", "operator:|", "string:echo hi: there", "string:# not a comment", "property:next", "number:1"]);
  });
  it("handles tags and survives odd input", () => {
    expect(y("a: !!str 5")).toEqual(["property:a", "type:!!str", "number:5"]);
    for (const src of ["- - - x", ": :", "a: 'open", "{[}]", "\t\t:\n"]) ascending(yamlTokens(src));
  });
});
