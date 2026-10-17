import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_COLOR_THEMES } from "../src/main/themes/builtin-themes.js";
import { ThemeService } from "../src/main/themes/theme-service.js";
import type { ContributionRegistrySnapshot } from "../src/shared/types.js";

let dir: string;
let registry: ContributionRegistrySnapshot;
const logs: string[] = [];

function emptyRegistry(): ContributionRegistrySnapshot {
  return { connectionTypes: [], explorerNodes: [], views: [], commands: [], themes: [], iconThemes: [], icons: [] };
}

function service() {
  return new ThemeService({
    getRegistry: () => registry,
    getPluginRoot: (id) => (id === "theme-pack" ? join(dir, "plugin") : undefined),
    builtinIconDir: join(dir, "builtin-icons"),
    settingsPath: join(dir, "settings.json"),
    log: (m) => logs.push(m),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-theme-"));
  mkdirSync(join(dir, "builtin-icons"));
  writeFileSync(join(dir, "builtin-icons", "folder.svg"), "<svg/>");
  writeFileSync(join(dir, "builtin-icons", "table.svg"), "<svg/>");
  mkdirSync(join(dir, "plugin", "icons"), { recursive: true });
  writeFileSync(join(dir, "plugin", "solar.json"), JSON.stringify({ colors: { "editor.background": "#002b36", "not.a.key": "#fff" } }));
  writeFileSync(join(dir, "plugin", "icons", "folder.svg"), "<svg/>");
  writeFileSync(join(dir, "plugin", "icons", "box.svg"), "<svg/>");
  writeFileSync(
    join(dir, "plugin", "icons", "theme.json"),
    JSON.stringify({ icons: { folder: { path: "folder.svg", colored: true }, table: "../../outside.svg" } }),
  );
  writeFileSync(join(dir, "outside.svg"), "<svg/>");
  registry = emptyRegistry();
  logs.length = 0;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ThemeService", () => {
  it("starts on the built-in dark theme with the built-in icons", () => {
    const s = service().getState();
    expect(s.colorTheme).toEqual({ id: "oneclient-dark", label: "oneClient Dark", kind: "dark" });
    expect(s.colors["editor.background"]).toBe("#1e1e1e");
    expect(Object.keys(s.icons).sort()).toEqual(["folder", "table"]);
  });

  it("applies a plugin theme on top of its base kind, ignoring unknown keys, and persists the choice", () => {
    registry.themes.push({ id: "solar", label: "Solar", uiTheme: "dark", path: "solar.json", pluginId: "theme-pack" });
    const svc = service();
    svc.setColorTheme("solar");
    const s = svc.getState();
    expect(s.colors["editor.background"]).toBe("#002b36");
    expect(s.colors["sideBar.background"]).toBe(BUILTIN_COLOR_THEMES[0]!.colors["sideBar.background"]); // inherited
    expect(s.colors["not.a.key"]).toBeUndefined();
    expect(logs.some((l) => l.includes("not.a.key"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ colorTheme: "solar" });
    // A new instance (app restart) restores it.
    expect(service().getState().colorTheme.id).toBe("solar");
  });

  it("previews without saving", () => {
    const svc = service();
    svc.setColorTheme("oneclient-light", false);
    expect(svc.getState().colorTheme.kind).toBe("light");
    expect(() => readFileSync(join(dir, "settings.json"), "utf8")).toThrow();
  });

  it("falls back to dark when the saved theme's plugin is gone, without forgetting the choice", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ colorTheme: "uninstalled-theme" }));
    expect(service().getState().colorTheme.id).toBe("oneclient-dark");
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).colorTheme).toBe("uninstalled-theme");
  });

  it("adds plugin icon ids but never lets them take over a built-in id", () => {
    registry.icons.push(
      { id: "box", path: "icons/box.svg", pluginId: "theme-pack" },
      { id: "folder", path: "icons/folder.svg", pluginId: "theme-pack" },
    );
    const svc = service();
    expect(svc.resolveIconFile("box")).toBe(join(dir, "plugin", "icons", "box.svg"));
    expect(svc.resolveIconFile("folder")).toBe(join(dir, "builtin-icons", "folder.svg"));
  });

  it("lets an icon theme restyle ids, with paths relative to the theme file and no escaping the plugin", () => {
    registry.iconThemes.push({ id: "pack", label: "Pack", path: "icons/theme.json", pluginId: "theme-pack" });
    const svc = service();
    const before = svc.getState().iconVersion;
    svc.setIconTheme("pack");
    expect(svc.resolveIconFile("folder")).toBe(join(dir, "plugin", "icons", "folder.svg"));
    expect(svc.getState().icons.folder).toEqual({ colored: true });
    expect(svc.resolveIconFile("table")).toBe(join(dir, "builtin-icons", "table.svg")); // traversal rejected
    expect(svc.getState().iconVersion).toBeGreaterThan(before);
  });

  it("rejects unknown theme ids", () => {
    expect(() => service().setColorTheme("nope")).toThrow(/Unknown color theme/);
    expect(() => service().setIconTheme("nope")).toThrow(/Unknown icon theme/);
  });
});
