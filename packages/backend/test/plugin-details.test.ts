import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/config-store.js";
import { PluginMetadataStore } from "../src/db/plugin-metadata-store.js";
import { describeContributions, installedPluginDetails } from "../src/plugins/plugin-details.js";
import { PluginManager } from "../src/plugins/plugin-manager.js";
import { ContributionRegistry } from "../src/plugins/registry.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "plugins");
let home: string | undefined;
afterEach(() => home && rmSync(home, { recursive: true, force: true }));

describe("describeContributions", () => {
  it("groups what a manifest adds by kind and leaves out hidden commands", () => {
    expect(
      describeContributions({
        connectionTypes: [{ id: "pg", label: "PostgreSQL" }],
        commands: [{ id: "a.run", title: "A: Run" }, { id: "a.internal", title: "Internal", hidden: true }],
        extensions: { "x.y": [] },
        views: [],
      }),
    ).toEqual([
      { kind: "Connection types", items: [{ id: "pg", title: "PostgreSQL" }] },
      { kind: "Commands", items: [{ id: "a.run", title: "A: Run" }] },
    ]);
  });
});

describe("installedPluginDetails", () => {
  it("describes an installed plugin from its manifest", async () => {
    home = mkdtempSync(join(tmpdir(), "oneclient-details-"));
    const manager = new PluginManager([fixtures], new ContributionRegistry(), new PluginMetadataStore(new ConfigStore(home)));
    await manager.scan();
    const details = await installedPluginDetails(manager.getRecord("oneclient-good-fixture")!);
    expect(details).toMatchObject({ id: "oneclient-good-fixture", displayName: "Good Fixture", version: "0.1.0", installed: true, engine: "^0.1.0" });
    expect(details.contributions?.map((c) => c.kind)).toEqual(["Connection types", "Commands"]);
  });
});
