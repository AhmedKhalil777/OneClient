import { describe, expect, it } from "vitest";
import { formatXml, parseXml, xmlSymbols, xmlTokens } from "../src/xml.js";

const fmt = (text: string, tab = 2, spaces = true) => {
  const r = formatXml(text, tab, spaces);
  if (!r.ok) throw new Error(r.error.message);
  return r.text;
};

describe("parseXml", () => {
  it("records offsets of elements, attributes and end tags", () => {
    const text = '<a id="1"><b/>text</a>';
    const { nodes, errors } = parseXml(text);
    expect(errors).toEqual([]);
    const a = nodes[0]!;
    expect(a.type === "element" && { name: a.name, start: a.start, end: a.end, close: a.closeStart, openEnd: a.openEnd }).toEqual({
      name: "a",
      start: 0,
      end: text.length,
      close: text.indexOf("</a>"),
      openEnd: 10,
    });
    if (a.type === "element") {
      expect(a.attrs[0]).toMatchObject({ name: "id", value: "1", quote: '"' });
      expect(a.children.map((c) => c.type)).toEqual(["element", "text"]);
    }
  });

  it("understands comments, CDATA, processing instructions and doctypes (with internal subsets)", () => {
    const { nodes, errors } = parseXml('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY e "x>y">]><!-- c --><r><![CDATA[<not-a-tag>]]></r>');
    expect(errors).toEqual([]);
    expect(nodes.map((n) => n.type)).toEqual(["pi", "doctype", "comment", "element"]);
  });

  it("keeps '>' inside attribute values", () => {
    const { nodes, errors } = parseXml('<a title="x > y" other=\'1\'/>');
    expect(errors).toEqual([]);
    expect(nodes[0]!.type === "element" && nodes[0]!.attrs.map((a) => a.value)).toEqual(["x > y", "1"]);
  });

  it("reports mismatched, unclosed and stray tags with offsets, and keeps going", () => {
    expect(parseXml("<a><b></a>").errors[0]).toMatchObject({ offset: 3, message: expect.stringContaining("<b> is not closed") });
    expect(parseXml("<a>").errors[0]).toMatchObject({ offset: 0, message: "Element <a> is not closed" });
    expect(parseXml("</x>").errors[0]).toMatchObject({ offset: 0, message: "Unexpected end tag </x>" });
    expect(parseXml("<a b></a>").errors[0]?.message).toMatch(/no value/);
    expect(parseXml("<a b=c></a>").errors[0]?.message).toMatch(/quoted/);
    expect(parseXml("a < b").errors[0]?.message).toMatch(/Unescaped/);
    expect(parseXml('<a b="x></a>').errors.length).toBeGreaterThan(0);
  });

  it("survives truncated input anywhere", () => {
    const doc = '<?xml version="1.0"?><!-- c --><root a="1"><child x=\'2\'>t<![CDATA[z]]></child><e/></root>';
    for (let n = 0; n <= doc.length; n++) expect(() => parseXml(doc.slice(0, n))).not.toThrow();
  });
});

describe("formatXml", () => {
  it("indents nested elements, one per line", () => {
    expect(fmt("<a><b><c/></b><d>x</d></a>")).toBe("<a>\n  <b>\n    <c />\n  </b>\n  <d>x</d>\n</a>".replace("<c />", "<c/>"));
  });

  it("collapses badly-indented input and honors tabs", () => {
    expect(fmt("<a>\n      <b>\n<c/>\n   </b>\n</a>", 4, false)).toBe("<a>\n\t<b>\n\t\t<c/>\n\t</b>\n</a>");
  });

  it("keeps each tag's self-closing style and normalizes attribute spacing", () => {
    expect(fmt('<r><a  x = "1"   y=\'2\' /><b z="3"/></r>')).toBe('<r>\n  <a x="1" y=\'2\' />\n  <b z="3"/>\n</r>');
  });

  it("leaves text content and mixed content exactly as written", () => {
    const mixed = "<p>Hello <b>big</b>  world</p>";
    expect(fmt(`<r><p>Hello <b>big</b>  world</p></r>`)).toBe(`<r>\n  ${mixed}\n</r>`);
    expect(fmt("<r><v>  spaced  </v><e></e><w>\n</w></r>")).toBe("<r>\n  <v>  spaced  </v>\n  <e></e>\n  <w></w>\n</r>");
    expect(fmt("<r><s><![CDATA[a < b]]></s></r>")).toBe("<r>\n  <s><![CDATA[a < b]]></s>\n</r>");
  });

  it("keeps comments, the declaration and one blank line between groups", () => {
    const input = '<?xml version="1.0"?>\n<r>\n<!-- first -->\n<a/>\n\n\n\n<b/>\n</r>\n';
    expect(fmt(input)).toBe('<?xml version="1.0"?>\n<r>\n  <!-- first -->\n  <a/>\n\n  <b/>\n</r>\n');
  });

  it("is idempotent", () => {
    const once = fmt('<?xml version="1.0"?><project><item id="1"><n>x</n></item><!-- c --><item id="2"/></project>');
    expect(fmt(once)).toBe(once);
  });

  it("preserves the trailing newline state", () => {
    expect(fmt("<a><b/></a>\n").endsWith("\n")).toBe(true);
    expect(fmt("<a><b/></a>").endsWith("\n")).toBe(false);
  });

  it("refuses malformed documents instead of guessing, pointing at the problem", () => {
    const r = formatXml("<a><b></a>", 2, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ offset: 3, message: expect.stringContaining("Can't format") });
  });

  it("realistic project file", () => {
    const csproj = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="X" Version="1" /></ItemGroup></Project>';
    expect(fmt(csproj)).toBe(
      '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="X" Version="1" />\n  </ItemGroup>\n</Project>',
    );
  });
});

describe("xmlSymbols", () => {
  const text = '<root>\n  <items>\n    <item id="a"><name>x</name></item>\n    <item name="b"/>\n  </items>\n</root>';
  const result = xmlSymbols(text);

  it("nests elements and labels them with an identifying attribute", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const root = result.symbols[0]!;
    expect(root).toMatchObject({ name: "root", kind: "element" });
    const items = root.children![0]!;
    expect(items.name).toBe("items");
    expect(items.children!.map((c) => `${c.name} ${c.detail ?? ""}`.trim())).toEqual(['item id="a"', 'item name="b"']);
  });

  it("gives ranges covering each whole element, so the cursor path can be found by offset", () => {
    if (!result.ok) throw new Error("unreachable");
    const first = result.symbols[0]!.children![0]!.children![0]!;
    expect(text.slice(first.start, first.end)).toBe('<item id="a"><name>x</name></item>');
  });

  it("reports a problem but still returns the structure so far", () => {
    const r = xmlSymbols("<a><b>");
    expect(r.ok && r.error?.message).toMatch(/not closed/);
    expect(r.ok && r.symbols[0]?.name).toBe("a");
  });
});

describe("xmlTokens", () => {
  it("classifies tag names, attributes, values, comments and punctuation", () => {
    const text = '<a href="x"><!-- c --></a>';
    const r = xmlTokens(text);
    if (!r.ok) throw new Error("unreachable");
    const toks: Array<[string, string]> = [];
    for (let i = 0; i < r.tokens.length; i += 3) toks.push([r.classes[r.tokens[i + 2]!]!, text.slice(r.tokens[i], r.tokens[i + 1])]);
    expect(toks).toEqual([
      ["punctuation", "<"],
      ["tag", "a"],
      ["attribute", "href"],
      ["punctuation", "="],
      ["string", '"x"'],
      ["punctuation", ">"],
      ["comment", "<!-- c -->"],
      ["punctuation", "</"],
      ["tag", "a"],
      ["punctuation", ">"],
    ]);
  });

  it("emits ascending, non-overlapping tokens even for self-closing and nested elements", () => {
    const r = xmlTokens('<r><a x="1"/><b>t</b></r>');
    if (!r.ok) throw new Error("unreachable");
    let last = -1;
    for (let i = 0; i < r.tokens.length; i += 3) {
      expect(r.tokens[i]!).toBeGreaterThanOrEqual(last);
      expect(r.tokens[i + 1]!).toBeGreaterThan(r.tokens[i]!);
      last = r.tokens[i + 1]!;
    }
  });
});
