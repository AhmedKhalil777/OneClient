import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_VERSION, ConfigStore, ConfigVersionError, migrateConfig } from "../src/main/config/config-store.js";
import { ConnectionManager } from "../src/main/connections/connection-manager.js";
import type { FileSecretStore } from "../src/main/secrets/secret-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oneclient-cfg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const conn = (id: string) => ({ id, name: `Conn ${id}`, typeId: "t", pluginId: "p", config: { host: "h" }, createdAt: "2026-01-01T00:00:00.000Z" });

describe("ConfigStore", () => {
  it("persists connections, plugin state and settings in oneclient.json", () => {
    const a = new ConfigStore(dir);
    a.addConnections([conn("1")]);
    a.setPluginEnabled("x", false);
    a.setSettings({ colorTheme: "dark" });

    const b = new ConfigStore(dir);
    expect(b.listConnections().map((c) => c.id)).toEqual(["1"]);
    expect(b.isPluginEnabled("x")).toBe(false);
    expect(b.isPluginEnabled("never-seen")).toBe(true);
    expect(b.getSettings()).toEqual({ colorTheme: "dark" });
    expect(JSON.parse(readFileSync(join(dir, "oneclient.json"), "utf-8")).connections[0].name).toBe("Conn 1");
  });

  it("removes connections", () => {
    const s = new ConfigStore(dir);
    s.addConnections([conn("1"), conn("2")]);
    s.removeConnection("1");
    expect(new ConfigStore(dir).listConnections().map((c) => c.id)).toEqual(["2"]);
  });

  it("sets a damaged file aside instead of overwriting it", () => {
    writeFileSync(join(dir, "oneclient.json"), "{ not json");
    const logs: string[] = [];
    const s = new ConfigStore(dir, (m) => logs.push(m));
    expect(s.listConnections()).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith("oneclient.json.broken-"))).toBe(true);
    expect(logs).toHaveLength(1);
  });
});

describe("config versioning", () => {
  it("writes the current version", () => {
    new ConfigStore(dir).setPluginEnabled("a", true);
    expect(JSON.parse(readFileSync(join(dir, "oneclient.json"), "utf-8")).version).toBe(CONFIG_VERSION);
  });

  it("migrates an unversioned file, keeps its data and leaves a backup", () => {
    writeFileSync(join(dir, "oneclient.json"), JSON.stringify({ connections: [conn("1")], plugins: { x: { enabled: false } } }));
    const store = new ConfigStore(dir);
    expect(store.listConnections().map((c) => c.id)).toEqual(["1"]);
    expect(store.isPluginEnabled("x")).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "oneclient.json"), "utf-8")).version).toBe(CONFIG_VERSION);
    expect(readdirSync(dir)).toContain("oneclient.json.v0.bak");
  });

  it("migrateConfig walks every step and reports what it did", () => {
    const r = migrateConfig({});
    expect(r.from).toBe(0);
    expect(r.to).toBe(CONFIG_VERSION);
    expect(r.applied).toHaveLength(CONFIG_VERSION);
    expect(r.data).toMatchObject({ version: CONFIG_VERSION, connections: [], plugins: {}, settings: {} });
  });

  it("refuses a file from a newer app without touching it", () => {
    const text = JSON.stringify({ version: CONFIG_VERSION + 1, connections: [conn("1")] });
    writeFileSync(join(dir, "oneclient.json"), text);
    expect(() => new ConfigStore(dir)).toThrow(ConfigVersionError);
    expect(readFileSync(join(dir, "oneclient.json"), "utf-8")).toBe(text);
    expect(readdirSync(dir)).toEqual(["oneclient.json"]);
  });

  it("remembers plugin versions and reports the previous one", () => {
    const s = new ConfigStore(dir);
    expect(s.recordPluginVersion("p", "1.0.0")).toBeUndefined();
    expect(s.recordPluginVersion("p", "1.1.0")).toBe("1.0.0");
    expect(s.isPluginEnabled("p")).toBe(true);
    expect(new ConfigStore(dir).recordPluginVersion("p", "1.1.0")).toBe("1.1.0");
  });
});

describe("connection export / import", () => {
  const installed: Record<string, string> = { p: "1.0.0" };
  function manager(secrets: Record<string, string> = {}, where: string = dir) {
    const config = new ConfigStore(where);
    const store = {
      async set(k: string, v: string) {
        secrets[k] = v;
      },
      async entriesByPrefix(prefix: string) {
        return Object.fromEntries(Object.entries(secrets).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
      },
    } as unknown as FileSecretStore;
    return { config, secrets, mgr: new ConnectionManager(config, {} as never, {} as never, store, async () => {}, async () => undefined, (id) => installed[id]) };
  }

  it("leaves secrets out unless asked, and includes them in plain text when asked", async () => {
    const { config, mgr } = manager({ "1:password": "hunter2" });
    config.addConnections([conn("1")]);
    const plain = await mgr.exportConnections(false);
    expect(JSON.stringify(plain)).not.toContain("hunter2");
    expect(plain.includesSecrets).toBe(false);
    const withSecrets = await mgr.exportConnections(true);
    expect(withSecrets.connections[0]?.secrets).toEqual({ password: "hunter2" });
  });

  it("imports, restoring secrets, and skips ids that already exist", async () => {
    const source = manager({ "1:password": "hunter2" });
    source.config.addConnections([conn("1")]);
    const file = await source.mgr.exportConnections(true);

    const other = mkdtempSync(join(tmpdir(), "oneclient-cfg2-"));
    const target = manager({}, other);
    const first = await target.mgr.importConnections(JSON.parse(JSON.stringify(file)));
    expect(first).toEqual({ added: 1, skipped: 0, invalid: 0, withoutSecrets: 0, warnings: [] });
    expect(target.config.listConnections().map((c) => c.name)).toEqual(["Conn 1"]);
    expect(target.secrets["1:password"]).toBe("hunter2");

    const again = await target.mgr.importConnections(file);
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(1);
    rmSync(other, { recursive: true, force: true });
  });

  it("warns about missing or older plugins and refuses exports from a newer app", async () => {
    const { mgr } = manager();
    const r = await mgr.importConnections({ format: "oneclient-connections", version: 1, plugins: { p: "2.0.0", gone: "1.0.0" }, connections: [conn("1"), { ...conn("2"), pluginId: "gone" }] });
    expect(r.added).toBe(2);
    expect(r.warnings.some((w) => w.includes("isn't installed"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("2.0.0"))).toBe(true);
    await expect(mgr.importConnections({ format: "oneclient-connections", version: 99, connections: [] })).rejects.toThrow(/newer version/);
  });

  it("counts connections imported without secrets, ignores junk, and rejects non-exports", async () => {
    const { mgr } = manager();
    const r = await mgr.importConnections({ connections: [conn("9"), { nope: true }] });
    expect(r).toEqual({ added: 1, skipped: 0, invalid: 1, withoutSecrets: 1, warnings: [] });
    await expect(mgr.importConnections({ hello: "world" })).rejects.toThrow(/connections/);
  });
});

describe("v1 → v2: Explorer folders become the workspace", () => {
  it("moves the old Files plugin's folder connections into workspace.folders (same ids) and drops retired plugins", () => {
    const folder = { id: "f1", name: "repo", typeId: "folder", pluginId: "oneclient-files", config: { path: "C:/src/repo" }, createdAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(
      join(dir, "oneclient.json"),
      JSON.stringify({ version: 1, settings: {}, plugins: { "oneclient-files": { enabled: true }, "oneclient-sample": { enabled: true }, redis: { enabled: false } }, connections: [folder, conn("2")] }),
    );
    const s = new ConfigStore(dir);
    expect(s.listFolders()).toEqual([{ id: "f1", name: "repo", path: "C:/src/repo" }]);
    expect(s.listConnections().map((c) => c.id)).toEqual(["2"]);
    expect(s.isPluginEnabled("redis")).toBe(false);
    const saved = JSON.parse(readFileSync(join(dir, "oneclient.json"), "utf-8"));
    expect(saved.version).toBe(2);
    expect(Object.keys(saved.plugins)).toEqual(["redis"]);
    expect(readdirSync(dir)).toContain("oneclient.json.v1.bak");
  });

  it("adds and removes workspace folders", () => {
    const s = new ConfigStore(dir);
    s.addFolder({ id: "a", name: "A", path: "/a" });
    s.addFolder({ id: "b", name: "B", path: "/b" });
    s.removeFolder("a");
    expect(new ConfigStore(dir).listFolders()).toEqual([{ id: "b", name: "B", path: "/b" }]);
  });
});
