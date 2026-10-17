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
  return { connectionTypes: [], explorerNodes: [], views: [], commands: [], themes: [], iconThemes: [], searchProviders: [], icons: [], extensions: [] };
}

function service() {
  return new ThemeService({
    getRegistry: () => registry,
    getPluginRoot: (id) => (id === "theme-pack" ? join(dir, "plugin") : undefined),
    builtinIconDir: join(dir, "builtin-icons"),
    settings: {
      load: () => {
        try {
          return JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
        } catch {
          return {};
        }
      },
      save: (next) => writeFileSync(join(dir, "settings.json"), JSON.stringify(next)),
    },
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

  describe("file icon themes", () => {
    beforeEach(() => {
      mkdirSync(join(dir, "plugin", "fi", "icons"), { recursive: true });
      for (const f of ["file", "folder", "folder-open", "ts", "ts-dark", "ts-light", "src"]) writeFileSync(join(dir, "plugin", "fi", "icons", `${f}.svg`), "<svg/>");
      writeFileSync(
        join(dir, "plugin", "fi", "theme.json"),
        JSON.stringify({
          colored: true,
          icons: {
            "x-file": "icons/file.svg",
            "x-folder": "icons/folder.svg",
            "x-folder-open": "icons/folder-open.svg",
            "x-ts": "icons/ts-dark.svg",
            "x-ts-light": "icons/ts-light.svg",
            "x-src": "icons/src.svg",
          },
          file: "x-file",
          folder: "x-folder",
          folderExpanded: "x-folder-open",
          fileExtensions: { TS: "x-ts", broken: "x-does-not-exist" },
          fileNames: { "Package.JSON": "x-ts" },
          folderNames: { ".src": "x-src" },
          light: { fileExtensions: { ts: "x-ts-light" } },
        }),
      );
      registry.iconThemes.push({ id: "fi", label: "File Icons", path: "fi/theme.json", pluginId: "theme-pack" });
    });

    it("exposes file/folder mappings (lower-cased, folder spellings normalized) and marks icons colored", () => {
      const svc = service();
      svc.setIconTheme("fi");
      const { fileIcons, icons } = svc.getState();
      expect(fileIcons?.file).toBe("x-file");
      expect(fileIcons?.fileExtensions).toEqual({ ts: "x-ts" }); // "broken" dropped: its icon id doesn't exist
      expect(fileIcons?.fileNames).toEqual({ "package.json": "x-ts" });
      expect(fileIcons?.folderNames).toEqual({ src: "x-src" });
      expect(icons["x-ts"]).toEqual({ colored: true });
    });

    it("applies the light overrides only in light color themes", () => {
      const svc = service();
      svc.setIconTheme("fi");
      expect(svc.getState().fileIcons?.fileExtensions.ts).toBe("x-ts");
      svc.setColorTheme("oneclient-light", false);
      expect(svc.getState().fileIcons?.fileExtensions.ts).toBe("x-ts-light");
      svc.setColorTheme("oneclient-dark", false);
      expect(svc.getState().fileIcons?.fileExtensions.ts).toBe("x-ts");
    });

    it("has no file icons for themes that only restyle ids", () => {
      mkdirSync(join(dir, "plugin", "pk"), { recursive: true });
      writeFileSync(join(dir, "plugin", "pk", "theme.json"), JSON.stringify({ icons: {} }));
      registry.iconThemes.push({ id: "pk", label: "Restyle only", path: "pk/theme.json", pluginId: "theme-pack" });
      const svc = service();
      svc.setIconTheme("pk");
      expect(svc.getState().fileIcons).toBeUndefined();
    });

    it("defaults to the preferred file icon theme when installed and nothing was chosen", () => {
      registry.iconThemes.push({ id: "oneclient-material-icons", label: "Material", path: "fi/theme.json", pluginId: "theme-pack" });
      expect(service().getState().iconTheme.id).toBe("oneclient-material-icons");
    });

    it("falls back to the default when the saved choice is gone (e.g. the old built-in theme)", () => {
      registry.iconThemes.push({ id: "oneclient-material-icons", label: "Material", path: "fi/theme.json", pluginId: "theme-pack" });
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ iconTheme: "oneclient-default" }));
      expect(service().getState().iconTheme.id).toBe("oneclient-material-icons");
    });

    it("has no icon theme (and no file icons) when none is installed", () => {
      registry.iconThemes.length = 0;
      const s = service().getState();
      expect(s.iconTheme.id).toBe("");
      expect(s.fileIcons).toBeUndefined();
    });
  });

  it("rejects unknown theme ids", () => {
    expect(() => service().setColorTheme("nope")).toThrow(/Unknown color theme/);
    expect(() => service().setIconTheme("nope")).toThrow(/Unknown icon theme/);
  });
});
