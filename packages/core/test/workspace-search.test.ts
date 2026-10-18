import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGlobFilter, buildRegExp, findInFiles, quickOpen, replaceInFiles, scoreName, walk } from "../src/main/workspace/search.js";

let root: string;
const put = (rel: string, content: string | Buffer) => {
  const full = join(root, ...rel.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "oneclient-search-"));
  put("README.md", "# Title\nHello World\n");
  put("src/plugin-manager.ts", "export class PluginManager {}\nconst hello = 'world';\n");
  put("src/util/helpers.ts", "// Hello helper\nexport const hello = 1;\r\nexport const HELLO = 2;\n");
  put("src/util/helpers.test.ts", "hello test\n");
  put("docs/guide.md", "hello docs\n");
  put("node_modules/lib/index.js", "hello from a dependency\n");
  put(".git/config", "hello git\n");
  put("bin/data.bin", Buffer.from([104, 101, 108, 108, 111, 0, 1, 2]));
  put("bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello bom\n")]));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("walk", () => {
  it("lists files, skipping vendor / VCS / build directories", async () => {
    const { files } = await walk(root);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("src/util/helpers.ts");
    expect(paths.some((p) => p.startsWith("node_modules/") || p.startsWith(".git/"))).toBe(false);
  });
});

describe("name scoring & quick open", () => {
  it("ranks exact > prefix > substring > scattered letters", () => {
    const s = (q: string, n: string) => scoreName(q, n, n);
    expect(s("helpers.ts", "helpers.ts")).toBeGreaterThan(s("help", "helpers.ts"));
    expect(s("help", "helpers.ts")).toBeGreaterThan(s("lper", "helpers.ts"));
    expect(s("lper", "helpers.ts")).toBeGreaterThan(s("hr", "helpers.ts") - 1);
    expect(s("pm", "plugin-manager.ts")).toBeGreaterThan(0);
    expect(s("gc", "GetCustomer.cs")).toBeGreaterThan(0);
    expect(s("hello", "SchedulerLog.cs")).toBe(0); // scattered letters alone are not a match
    expect(s("zzz", "helpers.ts")).toBe(0);
  });

  it("finds files by partial or scattered name, best first, as search results that open the editor", async () => {
    const r = await quickOpen("c1", root, "pm", 10);
    expect(r[0]).toMatchObject({ id: "src/plugin-manager.ts", label: "plugin-manager.ts", description: "src", openView: { viewId: "files.editor", params: { path: "src/plugin-manager.ts" } } });
    const help = await quickOpen("c1", root, "helpers", 10);
    expect(help.map((x) => x.label)).toEqual(["helpers.ts", "helpers.test.ts"]);
    expect(await quickOpen("c1", root, "nosuchfile", 10)).toEqual([]);
    expect((await quickOpen("c1", root, "e", 3)).length).toBeLessThanOrEqual(3);
  });
});

describe("globs", () => {
  it("matches bare names and folders anywhere, wildcards, ** and braces", () => {
    const f = buildGlobFilter("src, *.md", "**/*.test.ts, docs");
    expect(f("src/util/helpers.ts")).toBe(true);
    expect(f("src/util/helpers.test.ts")).toBe(false);
    expect(f("README.md")).toBe(true);
    expect(f("docs/guide.md")).toBe(false);
    expect(buildGlobFilter("*.{ts,md}", undefined)("a/b/c.md")).toBe(true);
    expect(buildGlobFilter("**/util/*.ts", undefined)("src/util/x.ts")).toBe(true);
    expect(buildGlobFilter("", "")("anything")).toBe(true);
  });
});

describe("find in files", () => {
  it("is case-insensitive by default and reports line, column and length", async () => {
    const r = await findInFiles(root, { query: "hello" });
    const helpers = r.files.find((f) => f.path === "src/util/helpers.ts")!;
    expect(helpers.matches.map((m) => [m.line, m.col, m.length])).toEqual([
      [1, 4, 5],
      [2, 14, 5],
      [3, 14, 5],
    ]);
    expect(r.files.some((f) => f.path.startsWith("node_modules/") || f.path.startsWith(".git/") || f.path === "bin/data.bin")).toBe(false);
  });

  it("supports match case, whole word, regex and include/exclude", async () => {
    expect((await findInFiles(root, { query: "hello", caseSensitive: true, include: "helpers.ts" })).totalMatches).toBe(1);
    expect((await findInFiles(root, { query: "hell", wholeWord: true })).totalMatches).toBe(0);
    const re = await findInFiles(root, { query: "export (class|const) (\\w+)", regex: true, include: "src" });
    expect(re.totalMatches).toBe(3);
    const ex = await findInFiles(root, { query: "hello", exclude: "src, docs, *.txt" });
    expect(ex.files.map((f) => f.path)).toEqual(["README.md"]);
  });

  it("rejects an invalid regular expression and an empty query", async () => {
    await expect(findInFiles(root, { query: "(", regex: true })).rejects.toThrow(/Invalid regular expression/);
    expect(() => buildRegExp({ query: "" })).toThrow();
  });

  it("stops at maxResults and says so", async () => {
    const r = await findInFiles(root, { query: "hello", maxResults: 2 });
    expect(r.totalMatches).toBe(2);
    expect(r.truncated).toBe(true);
  });
});

describe("replace in files", () => {
  it("replaces literally, keeping line endings and the BOM, only in the files asked for", async () => {
    const r = await replaceInFiles(root, { query: "hello", caseSensitive: true, replacement: "$1 bye", paths: ["src/util/helpers.ts", "bom.txt"] });
    expect(r).toMatchObject({ filesChanged: 2, replacements: 2, errors: [] });
    expect(readFileSync(join(root, "src/util/helpers.ts"), "utf-8")).toBe("// Hello helper\nexport const $1 bye = 1;\r\nexport const HELLO = 2;\n");
    const bom = readFileSync(join(root, "bom.txt"));
    expect([...bom.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bom.toString("utf-8", 3)).toBe("$1 bye bom\n");
    expect(readFileSync(join(root, "docs/guide.md"), "utf-8")).toBe("hello docs\n");
  });

  it("expands $1 / $& in regex mode", async () => {
    put("r.txt", "a=1\nb=2\n");
    const r = await replaceInFiles(root, { query: "(\\w)=(\\d)", regex: true, replacement: "$2:$1 [$&]", paths: ["r.txt"] });
    expect(r.replacements).toBe(2);
    expect(readFileSync(join(root, "r.txt"), "utf-8")).toBe("1:a [a=1]\n2:b [b=2]\n");
  });
});
