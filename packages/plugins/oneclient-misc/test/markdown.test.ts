import { describe, expect, it } from "vitest";
import { markdownPreview, markdownSymbols, markdownTokens } from "../src/markdown.js";

const html = (md: string) => {
  const r = markdownPreview(md);
  if (!r.ok) throw new Error("preview failed");
  return r.html;
};

describe("markdownSymbols", () => {
  const text = "# Title\n\nintro\n\n## One\n\ntext\n\n### Deep\n\n## Two\n\nSetext\n======\n";
  const r = markdownSymbols(text);

  it("nests headings by level", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.symbols.map((s) => s.name)).toEqual(["Title", "Setext"]);
    const title = r.symbols[0]!;
    expect(title.children!.map((s) => s.name)).toEqual(["One", "Two"]);
    expect(title.children![0]!.children!.map((s) => s.name)).toEqual(["Deep"]);
  });

  it("gives each heading a range up to the next heading of the same or higher level", () => {
    if (!r.ok) throw new Error("unreachable");
    const one = r.symbols[0]!.children![0]!;
    expect(text.slice(one.start, one.end)).toBe("## One\n\ntext\n\n### Deep\n\n");
    const deep = one.children![0]!;
    expect(text.slice(deep.start, deep.end)).toBe("### Deep\n\n");
  });

  it("ignores '#' lines inside fenced code and strips inline markup from titles", () => {
    const res = markdownSymbols("```sh\n# not a heading\n```\n\n## The `code` and [link](http://x)\n");
    expect(res.ok && res.symbols.map((s) => s.name)).toEqual(["The code and link"]);
  });

  it("doesn't mistake a list item or a rule for a setext heading", () => {
    const res = markdownSymbols("- item\n---\n\nParagraph\n\n---\n");
    expect(res.ok && res.symbols).toEqual([]);
  });
});

describe("markdownTokens", () => {
  const classify = (text: string) => {
    const r = markdownTokens(text);
    if (!r.ok) throw new Error("unreachable");
    const out: Array<[string, string]> = [];
    for (let i = 0; i < r.tokens.length; i += 3) out.push([r.classes[r.tokens[i + 2]!]!, text.slice(r.tokens[i], r.tokens[i + 1])]);
    return out;
  };

  it("colors headings, quotes, list markers and fenced code lines", () => {
    expect(classify("# Hi\n> quoted\n- item\n```js\nlet x\n```")).toEqual([
      ["heading", "# Hi"],
      ["quote", "> quoted"],
      ["list", "-"],
      ["code", "```js"],
      ["code", "let x"],
      ["code", "```"],
    ]);
  });

  it("colors inline code, emphasis, strong and links, but not inside code spans", () => {
    expect(classify("a `x *y*` **b** *c* [t](http://u)")).toEqual([
      ["code", "`x *y*`"],
      ["strong", "**b**"],
      ["emphasis", "*c*"],
      ["link", "[t](http://u)"],
    ]);
  });

  it("emits ascending, non-overlapping tokens", () => {
    const r = markdownTokens("# T\n\n- **a** and `b`\n> q *x*\n\n```\ncode\n```\n[l](u) _e_\n");
    if (!r.ok) throw new Error("unreachable");
    let last = -1;
    for (let i = 0; i < r.tokens.length; i += 3) {
      expect(r.tokens[i]!).toBeGreaterThanOrEqual(last);
      last = r.tokens[i + 1]!;
    }
  });
});

describe("markdownPreview", () => {
  it("renders common Markdown", () => {
    const out = html("# Title\n\nSome **bold** text and a [link](https://example.com).\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n");
    expect(out).toContain('<h1 id="title">Title</h1>');
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain('<a href="https://example.com">link</a>');
    expect(out).toContain("<table>");
  });

  it("never renders raw HTML from the source", () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\nhi <b>there</b>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("refuses dangerous link schemes", () => {
    const out = html("[x](javascript:alert(1)) [y](data:text/html;base64,AAAA) [z](vbscript:x)");
    expect(out).not.toMatch(/href="(javascript|data|vbscript):/i);
  });

  it("gives duplicate headings unique anchors", () => {
    const out = html("## Notes\n\n## Notes\n\n## Notes");
    expect(out).toContain('id="notes"');
    expect(out).toContain('id="notes-1"');
    expect(out).toContain('id="notes-2"');
  });

  it("highlights fenced code and escapes unknown languages", () => {
    const js = html("```js\nconst a = 1; // hi\n```");
    expect(js).toContain('class="hljs"');
    expect(js).toContain("hljs-keyword");
    const unknown = html("```nope\n<b>x</b>\n```");
    expect(unknown).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("renders task lists as disabled checkboxes", () => {
    const out = html("- [ ] todo\n- [x] done\n");
    expect(out).toContain('<input type="checkbox" disabled> todo');
    expect(out).toContain('<input type="checkbox" disabled checked> done');
  });

  it("ships CSS that uses theme variables", () => {
    const r = markdownPreview("x");
    expect(r.ok && r.css).toContain("var(--oc-syntax-keyword");
  });
});
