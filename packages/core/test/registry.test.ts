import { describe, expect, it } from "vitest";
import { ContributionRegistry } from "../src/main/plugins/registry.js";

describe("ContributionRegistry extension points", () => {
  const POINT = "oneclient-files.editors";

  function registry() {
    const r = new ContributionRegistry();
    r.addPlugin("oneclient-json", { extensions: { [POINT]: [{ id: "json", label: "JSON", extensions: ["json"] }] } });
    r.addPlugin("oneclient-xml", { extensions: { [POINT]: [{ id: "xml", label: "XML" }], "other.point": [{ id: "x" }] } });
    r.addPlugin("plain", {});
    return r;
  }

  it("returns every plugin's items for a point, tagged with the contributing plugin", () => {
    expect(registry().getExtensions(POINT)).toEqual([
      { id: "json", label: "JSON", extensions: ["json"], pluginId: "oneclient-json" },
      { id: "xml", label: "XML", pluginId: "oneclient-xml" },
    ]);
  });

  it("never lets an item claim to come from another plugin", () => {
    const r = new ContributionRegistry();
    r.addPlugin("evil", { extensions: { [POINT]: [{ id: "x", pluginId: "oneclient-json" }] } });
    expect(r.getExtensions(POINT)).toEqual([{ id: "x", pluginId: "evil" }]);
  });

  it("returns nothing for unknown points and forgets a plugin's contributions when it's removed", () => {
    const r = registry();
    expect(r.getExtensions("nope.point")).toEqual([]);
    r.removePlugin("oneclient-json");
    expect(r.getExtensions(POINT).map((i) => i.pluginId)).toEqual(["oneclient-xml"]);
  });

  it("includes extensions in the snapshot", () => {
    const snap = registry().snapshot().extensions;
    expect(snap.map((e) => `${e.pluginId}:${e.point}`)).toEqual([
      `oneclient-json:${POINT}`,
      `oneclient-xml:${POINT}`,
      "oneclient-xml:other.point",
    ]);
  });
});
