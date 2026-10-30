import { describe, expect, it } from "vitest";
import { compatibleReleases, parseCatalog, supports } from "../src/plugins/plugin-catalog.js";

const release = (version: string, app: string, engine = "^0.1.0") => ({ version, app, engine, url: `https://example.test/${version}.tgz`, sha512: "sha512-abc", size: 10 });

describe("parseCatalog", () => {
  it("reads plugin.json, newest release first", () => {
    const catalog = parseCatalog({ schema: 1, app: { version: "0.1.0" }, plugins: { "oneclient-demo": { description: "Demo", releases: [release("0.9.0", ">=0.1.0"), release("0.10.0", ">=0.1.0")] } } });
    expect(catalog.plugins["oneclient-demo"]!.releases.map((r) => r.version)).toEqual(["0.10.0", "0.9.0"]);
    expect(catalog.plugins["oneclient-demo"]!.description).toBe("Demo");
  });

  it("drops releases that are malformed or not served over https, keeping the rest", () => {
    const catalog = parseCatalog({
      schema: 1,
      plugins: {
        "oneclient-demo": {
          releases: [release("1.0.0", ">=0.1.0"), { ...release("1.1.0", ">=0.1.0"), url: "http://example.test/x.tgz" }, { ...release("1.2.0", "not a range!!") }, { ...release("1.3.0", ">=0.1.0"), sha512: "md5-x" }, { version: "nope" }],
        },
        "../evil": { releases: [release("1.0.0", "*")] },
      },
    });
    expect(Object.keys(catalog.plugins)).toEqual(["oneclient-demo"]);
    expect(catalog.plugins["oneclient-demo"]!.releases.map((r) => r.version)).toEqual(["1.0.0"]);
  });

  it("rejects a file that isn't a catalog", () => {
    expect(() => parseCatalog(null)).toThrow(/catalog/);
    expect(() => parseCatalog({ schema: 2, plugins: {} })).toThrow(/catalog/);
  });
});

describe("compatibility", () => {
  const plugin = parseCatalog({ schema: 1, plugins: { "oneclient-demo": { releases: [release("3.0.0", ">=0.3.0"), release("2.0.0", ">=0.2.0 <0.3.0"), release("1.0.0", ">=0.1.0 <0.2.0", "^0.0.1")] } } }).plugins["oneclient-demo"]!;

  it("matches the app version against each release's range", () => {
    expect(compatibleReleases(plugin, "0.2.5", "0.1.0").map((r) => r.version)).toEqual(["2.0.0"]);
    expect(compatibleReleases(plugin, "0.3.0", "0.1.0").map((r) => r.version)).toEqual(["3.0.0"]);
    expect(compatibleReleases(plugin, "0.1.0", "0.1.0")).toEqual([]); // 1.0.0 also needs plugin API ^0.0.1
  });

  it("treats a pre-release app build like its release", () => {
    expect(supports(plugin.releases[1]!, "0.2.5-beta.1", "0.1.0")).toBe(true);
  });
});
