import { describe, expect, it } from "vitest";
import { type ResolvedFileEditorContribution, matchFileEditors } from "../src/file-editor.js";

const json: ResolvedFileEditorContribution = {
  id: "json",
  label: "JSON",
  pluginId: "oneclient-json",
  extensions: ["json", "jsonc"],
  fileNames: [".babelrc"],
  format: "json.format",
  symbols: "json.symbols",
  tokens: "json.tokens",
  actions: [{ id: "minify", label: "Minify", command: "json.minify" }],
};
const tsconfig: ResolvedFileEditorContribution = {
  id: "tsconfig",
  label: "TypeScript Config",
  pluginId: "ts-tools",
  fileNames: ["tsconfig.json"],
  symbols: "ts.symbols",
};
const markdown: ResolvedFileEditorContribution = {
  id: "md",
  label: "Markdown",
  pluginId: "oneclient-markdown",
  extensions: ["md", "markdown"],
  preview: "md.preview",
  previewByDefault: true,
};
const textTools: ResolvedFileEditorContribution = {
  id: "text",
  label: "Text",
  pluginId: "oneclient-text-tools",
  extensions: ["*"],
  actions: [
    { id: "sort", label: "Sort Lines", command: "text.sort" },
    { id: "trim", label: "Trim", command: "text.trim" },
  ],
};
const all = [textTools, json, markdown, tsconfig];

describe("matchFileEditors", () => {
  it("gives a file the features of the contribution matching its extension", () => {
    const f = matchFileEditors(all, "data.JSON");
    expect(f.label).toBe("JSON");
    expect(f.format).toBe("json.format");
    expect(f.symbols).toBe("json.symbols");
    expect(f.tokens).toBe("json.tokens");
    expect(f.preview).toBeUndefined();
    expect(f.previewByDefault).toBe(false);
  });

  it("lets an exact file name beat an extension, but keeps features it doesn't provide from the extension match", () => {
    const f = matchFileEditors(all, "tsconfig.json");
    expect(f.label).toBe("TypeScript Config");
    expect(f.symbols).toBe("ts.symbols"); // more specific wins…
    expect(f.format).toBe("json.format"); // …yet JSON still formats it
  });

  it("combines actions from every matching contribution, specific first, wildcard last", () => {
    const f = matchFileEditors(all, "a.json");
    expect(f.actions.map((a) => `${a.pluginId}:${a.id}`)).toEqual([
      "oneclient-json:minify",
      "oneclient-text-tools:sort",
      "oneclient-text-tools:trim",
    ]);
  });

  it("lets wildcard contributions extend every file, including ones nothing else handles", () => {
    const f = matchFileEditors(all, "notes.unknown");
    expect(f.label).toBeUndefined();
    expect(f.format).toBeUndefined();
    expect(f.actions.map((a) => a.id)).toEqual(["sort", "trim"]);
  });

  it("opens the preview by default only when a matching contribution has one", () => {
    expect(matchFileEditors(all, "README.md")).toMatchObject({ preview: "md.preview", previewByDefault: true, label: "Markdown" });
  });

  it("matches multi-part extensions and prefers the longer one", () => {
    const dts: ResolvedFileEditorContribution = { id: "dts", label: "Declarations", pluginId: "p", extensions: ["d.ts"], symbols: "dts.symbols" };
    const ts: ResolvedFileEditorContribution = { id: "ts", label: "TypeScript", pluginId: "p", extensions: ["ts"], symbols: "ts.symbols" };
    expect(matchFileEditors([ts, dts], "index.d.ts").symbols).toBe("dts.symbols");
    expect(matchFileEditors([ts, dts], "index.ts").symbols).toBe("ts.symbols");
  });

  it("returns empty features when nothing matches", () => {
    expect(matchFileEditors([], "a.txt")).toEqual({
      label: undefined,
      format: undefined,
      symbols: undefined,
      tokens: undefined,
      preview: undefined,
      previewByDefault: false,
      actions: [],
    });
  });
});
