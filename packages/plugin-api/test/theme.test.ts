import { describe, expect, it } from "vitest";
import {
  type FileIconAssociations,
  THEME_COLOR_KEYS,
  colorVarName,
  iconUrl,
  normalizeFolderName,
  parseIconRef,
  resolveFileIcon,
} from "../src/theme.js";

const assoc: FileIconAssociations = {
  file: "f-default",
  folder: "d-default",
  folderExpanded: "d-default-open",
  fileExtensions: { ts: "f-ts", "spec.ts": "f-test-ts", json: "f-json", gitignore: "f-wrong" },
  fileNames: { "package.json": "f-node", ".gitignore": "f-git", dockerfile: "f-docker" },
  folderNames: { src: "d-src", git: "d-git" },
  folderNamesExpanded: { src: "d-src-open" },
};

describe("resolveFileIcon", () => {
  it("prefers exact file names over extensions, case-insensitively", () => {
    expect(resolveFileIcon(assoc, "package.json", "file")).toBe("f-node");
    expect(resolveFileIcon(assoc, "Dockerfile", "file")).toBe("f-docker");
    expect(resolveFileIcon(assoc, ".gitignore", "file")).toBe("f-git"); // name wins over the "gitignore" extension
  });

  it("matches the longest extension first, then shorter ones", () => {
    expect(resolveFileIcon(assoc, "app.spec.ts", "file")).toBe("f-test-ts");
    expect(resolveFileIcon(assoc, "app.config.ts", "file")).toBe("f-ts");
    expect(resolveFileIcon(assoc, "DATA.JSON", "file")).toBe("f-json");
  });

  it("falls back to the theme's default file icon", () => {
    expect(resolveFileIcon(assoc, "README", "file")).toBe("f-default");
    expect(resolveFileIcon(assoc, "archive.unknownext", "file")).toBe("f-default");
  });

  it("resolves folders by name, ignoring . _ - decoration, with open variants", () => {
    expect(resolveFileIcon(assoc, "src", "folder")).toBe("d-src");
    expect(resolveFileIcon(assoc, ".git", "folder")).toBe("d-git");
    expect(resolveFileIcon(assoc, "__src__", "folder")).toBe("d-src");
    expect(resolveFileIcon(assoc, "src", "folder", true)).toBe("d-src-open");
    expect(resolveFileIcon(assoc, "git", "folder", true)).toBe("d-default-open"); // no expanded entry → generic open folder
    expect(resolveFileIcon(assoc, "random", "folder")).toBe("d-default");
  });

  it("returns undefined without associations, so callers keep their own icon", () => {
    expect(resolveFileIcon(undefined, "a.ts", "file")).toBeUndefined();
  });

  it("normalizes folder names", () => {
    expect(normalizeFolderName(".GitHub")).toBe("github");
    expect(normalizeFolderName("__tests__")).toBe("tests");
    expect(normalizeFolderName("...")).toBe("..."); // never normalizes to empty
  });
});

describe("theme helpers", () => {
  it("maps color keys to CSS variables", () => {
    expect(colorVarName("editor.background")).toBe("--oc-editor-background");
    expect(colorVarName("terminal.ansiBrightRed")).toBe("--oc-terminal-ansiBrightRed");
    expect(colorVarName("foreground")).toBe("--oc-foreground");
  });

  it("parses $(icon) references and ignores plain paths", () => {
    expect(parseIconRef("$(database)")).toBe("database");
    expect(parseIconRef("$(docker-container)")).toBe("docker-container");
    expect(parseIconRef("icons/folder.svg")).toBeUndefined();
    expect(parseIconRef("$(Bad Id)")).toBeUndefined();
    expect(parseIconRef(undefined)).toBeUndefined();
  });

  it("builds icon URLs on the reserved oneclient.icons host", () => {
    expect(iconUrl("table", 3)).toBe("oneclient-asset://oneclient.icons/table.svg?v=3");
  });

  it("has no duplicate color keys", () => {
    expect(new Set(THEME_COLOR_KEYS).size).toBe(THEME_COLOR_KEYS.length);
  });
});
