import { describe, expect, it } from "vitest";
import { parseMarkdown, splitRow } from "../src-ui/md-parse.js";

describe("markdown blocks", () => {
  it("parses the table from the screenshot, with a leading and trailing pipe", () => {
    const md = "There are 8 databases:\n\n| Database | Recovery model |\n|---|---|\n| erd_demo | FULL |\n| master | SIMPLE |\n\nThe first one…";
    const b = parseMarkdown(md);
    expect(b.map((x) => x.t)).toEqual(["p", "table", "p"]);
    expect(b[1]).toMatchObject({ t: "table", head: ["Database", "Recovery model"], rows: [["erd_demo", "FULL"], ["master", "SIMPLE"]] });
  });

  it("handles alignment, escaped pipes, code with pipes and short rows", () => {
    const [t] = parseMarkdown("a | b | c\n:-- | :-: | --:\n`x|y` | 1\\|2");
    expect(t).toMatchObject({ t: "table", align: ["left", "center", "right"], rows: [["`x|y`", "1|2", ""]] });
    expect(splitRow("| a | `b|c` |")).toEqual(["a", "`b|c`"]);
  });

  it("does not mistake a line with a pipe for a table", () => {
    expect(parseMarkdown("use a | b here").map((b) => b.t)).toEqual(["p"]);
  });

  it("keeps mermaid and other fences apart, including an unclosed (streaming) one", () => {
    const [m, c, open] = parseMarkdown("```mermaid\ngraph TD\nA-->B\n```\n\n```ts\nconst x = 1;\n```\n\n```mermaid\ngraph LR\nA-->");
    expect(m).toEqual({ t: "code", lang: "mermaid", code: "graph TD\nA-->B", open: false });
    expect(c).toMatchObject({ lang: "ts", code: "const x = 1;", open: false });
    expect(open).toMatchObject({ lang: "mermaid", open: true });
  });

  it("parses nested and task lists, ordered lists and quotes", () => {
    const [list] = parseMarkdown("- one\n  - nested a\n  - nested b\n- [x] done\n- [ ] todo");
    expect(list).toMatchObject({ t: "list", ordered: false });
    const l = list as Extract<(typeof list), { t: "list" }>;
    expect(l.items).toHaveLength(3);
    expect(l.items[0]!.children.map((c) => c.t)).toEqual(["p", "list"]);
    expect(l.items.map((i) => i.checked)).toEqual([null, true, false]);
    const [ol] = parseMarkdown("3. a\n4. b");
    expect(ol).toMatchObject({ ordered: true, start: 3 });
    const [q] = parseMarkdown("> quoted **text**\n> more");
    expect(q).toMatchObject({ t: "quote" });
  });

  it("parses headings, rules and paragraphs with line breaks", () => {
    const b = parseMarkdown("# Title\n\nline one\nline two\n\n---\n\n### Small");
    expect(b).toEqual([{ t: "h", level: 1, text: "Title" }, { t: "p", text: "line one\nline two" }, { t: "hr" }, { t: "h", level: 3, text: "Small" }]);
  });

  it("never throws on odd input", () => {
    for (const s of ["", "|", "|||\n|||", "- ", "> ", "```", "1.", "*", "[x](", "\n\n\n", "| a |\n|---|", "- a\n\n\n  b"]) expect(() => parseMarkdown(s)).not.toThrow();
  });
});
