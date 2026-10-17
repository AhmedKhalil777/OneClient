import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/main/db/database.js";
import { PluginMetadataStore } from "../src/main/db/plugin-metadata-store.js";
import { PluginManager } from "../src/main/plugins/plugin-manager.js";
import { ContributionRegistry } from "../src/main/plugins/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures", "plugins");

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function setup() {
  const registry = new ContributionRegistry();
  const metadata = new PluginMetadataStore(db);
  const pluginManager = new PluginManager([fixturesDir], registry, metadata);
  return { registry, pluginManager };
}

describe("PluginManager.scan", () => {
  it("loads a valid, compatible plugin and merges its contributes into the registry", async () => {
    const { registry, pluginManager } = setup();
    await pluginManager.scan();

    const good = pluginManager.getRecord("oneclient-good-fixture");
    expect(good?.state).toBe("inactive");
    expect(good?.error).toBeUndefined();

    const snapshot = registry.snapshot();
    expect(snapshot.connectionTypes).toContainEqual(
      expect.objectContaining({ id: "good", pluginId: "oneclient-good-fixture" }),
    );
    expect(snapshot.commands).toContainEqual(
      expect.objectContaining({ id: "good.ping", pluginId: "oneclient-good-fixture" }),
    );
  });

  it("rejects a manifest that fails schema validation, and never adds it to the registry", async () => {
    const { registry, pluginManager } = setup();
    await pluginManager.scan();

    const bad = pluginManager.getRecord("oneclient-bad-fixture");
    expect(bad?.state).toBe("invalid");
    expect(bad?.error).toBeTruthy();
    expect(registry.findConnectionTypeOwner("oneclient-bad-fixture")).toBeUndefined();
  });

  it("rejects a plugin whose engines.oneclient range the host doesn't satisfy", async () => {
    const { registry, pluginManager } = setup();
    await pluginManager.scan();

    const incompatible = pluginManager.getRecord("oneclient-future-fixture");
    expect(incompatible?.state).toBe("incompatible");
    expect(incompatible?.error).toMatch(/engine/i);
    expect(registry.snapshot().commands.some((c) => c.pluginId === "oneclient-future-fixture")).toBe(false);
  });

  it("silently skips directories with no oneclient.json", async () => {
    const { pluginManager } = setup();
    await pluginManager.scan();
    expect(pluginManager.getRecord("not-a-plugin")).toBeUndefined();
  });

  it("emits 'loaded' only for valid, enabled plugins — not invalid or incompatible ones", async () => {
    const { pluginManager } = setup();
    const loadedIds: string[] = [];
    pluginManager.on("loaded", (record) => loadedIds.push(record.id));

    await pluginManager.scan();

    expect(loadedIds).toEqual(["oneclient-good-fixture"]);
  });

  it("persists a disabled plugin's state across a rescan (SQLite-backed)", async () => {
    const first = setup();
    await first.pluginManager.scan();
    first.pluginManager.setEnabled("oneclient-good-fixture", false);
    expect(first.pluginManager.getRecord("oneclient-good-fixture")?.state).toBe("disabled");

    // A fresh PluginManager over the SAME db simulates an app restart.
    const registry2 = new ContributionRegistry();
    const metadata2 = new PluginMetadataStore(db);
    const secondScan = new PluginManager([fixturesDir], registry2, metadata2);
    await secondScan.scan();

    expect(secondScan.getRecord("oneclient-good-fixture")?.state).toBe("disabled");
    expect(registry2.findConnectionTypeOwner("good")).toBeUndefined();
  });
});
