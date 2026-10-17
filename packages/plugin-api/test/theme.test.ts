import { describe, expect, it } from "vitest";
import { THEME_COLOR_KEYS, colorVarName, iconUrl, parseIconRef } from "../src/theme.js";

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
