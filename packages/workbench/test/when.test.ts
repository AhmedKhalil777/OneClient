import { describe, expect, it } from "vitest";
import { evaluateWhen } from "../src/when.js";

describe("when clauses", () => {
  const row = { contextValue: "connection", connectionType: "kafka" };

  it("handles == / != / =~ / bare / ! terms with && binding tighter than ||", () => {
    expect(evaluateWhen("contextValue == 'connection' && connectionType == 'kafka'", row)).toBe(true);
    expect(evaluateWhen("contextValue != 'connection' || connectionType == 'kafka'", row)).toBe(true);
    expect(evaluateWhen("connectionType =~ /^kaf/", row)).toBe(true);
    expect(evaluateWhen("!nodeType && contextValue", row)).toBe(true);
    expect(evaluateWhen("contextValue == 'x' && connectionType == 'kafka' || nodeType", row)).toBe(false);
  });

  it("supports parentheses (and negated groups)", () => {
    const expr = "(contextValue == 'connection' && connectionType == 'kafka') || contextValue == 'kafka.topics'";
    expect(evaluateWhen(expr, row)).toBe(true);
    expect(evaluateWhen(expr, { contextValue: "kafka.topics" })).toBe(true);
    expect(evaluateWhen(expr, { contextValue: "connection", connectionType: "redis" })).toBe(false);
    expect(evaluateWhen("!(activeView == 'a' || activeView == 'b') && activePlugin == 'p'", { activeView: "c", activePlugin: "p" })).toBe(true);
    expect(evaluateWhen("(a == '1') && (b == '2')", { a: "1", b: "2" } as never)).toBe(true);
  });

  it("is false for anything unparseable", () => {
    expect(evaluateWhen("(contextValue == 'connection'", row)).toBe(false);
    expect(evaluateWhen("contextValue === 'connection'", row)).toBe(false);
  });
});
