import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "../src/fuzzy.js";
import { wordsProvider } from "../src/providers/words.js";
import { rankCompletions } from "../src/rank.js";
import { applyCompletion, linePrefixAt, wordAt } from "../src/text.js";

describe("fuzzyMatch", () => {
  it("matches prefixes case-insensitively and ranks them above subsequences", () => {
    const prefix = fuzzyMatch("sel", "SELECT")!;
    const sub = fuzzyMatch("sel", "ISNULL_SELECTOR")!;
    expect(prefix.positions).toEqual([0, 1, 2]);
    expect(prefix.score).toBeGreaterThan(sub.score);
  });

  it("prefers word-boundary hits (camelCase, underscore)", () => {
    const m = fuzzyMatch("ci", "CustomerId")!;
    expect(m.positions).toEqual([0, 8]);
    expect(fuzzyMatch("oi", "order_id")!.positions).toEqual([0, 6]);
  });

  it("returns null when characters are missing or out of order", () => {
    expect(fuzzyMatch("xyz", "SELECT")).toBeNull();
    expect(fuzzyMatch("ts", "SET")).toBeNull();
  });

  it("requires the first character to start a word", () => {
    expect(fuzzyMatch("se", "Customers")).toBeNull();
    expect(fuzzyMatch("id", "CustomerId")).not.toBeNull();
  });

  it("matches everything for an empty pattern", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });
});

describe("rankCompletions", () => {
  const items = [
    { label: "SELECT", kind: "keyword" as const },
    { label: "SET", kind: "keyword" as const },
    { label: "Customers", kind: "table" as const },
    { label: "SELECT", kind: "keyword" as const }, // duplicate from another provider
    { label: "[Order Details]", filterText: "Order Details", kind: "table" as const },
  ];

  it("filters, dedupes and orders best match first", () => {
    expect(rankCompletions(items, "se").map((r) => r.item.label)).toEqual(["SET", "SELECT"]);
  });

  it("matches on filterText when given", () => {
    expect(rankCompletions(items, "ord").map((r) => r.item.label)).toEqual(["[Order Details]"]);
  });

  it("uses sortText to break ties", () => {
    const ranked = rankCompletions(
      [
        { label: "b", sortText: "2" },
        { label: "a", sortText: "3" },
        { label: "c", sortText: "1" },
      ],
      "",
    );
    expect(ranked.map((r) => r.item.label)).toEqual(["c", "b", "a"]);
  });
});

describe("text helpers", () => {
  it("finds the word before the caret, including SQL sigils", () => {
    expect(wordAt("SELECT @@ROWC", 13)).toEqual({ start: 7, prefix: "@@ROWC" });
    expect(wordAt("FROM dbo.Cus", 12)).toEqual({ start: 9, prefix: "Cus" });
    expect(wordAt("a b ", 4)).toEqual({ start: 4, prefix: "" });
  });

  it("returns the line text up to the caret", () => {
    expect(linePrefixAt("one\ntwo three", 10)).toBe("two th");
  });

  it("replaces the typed word and places the caret at $0", () => {
    expect(applyCompletion("SELECT cou FROM t", 7, 10, "COUNT($0)")).toEqual({
      text: "SELECT COUNT() FROM t",
      insert: "COUNT()",
      caret: 13,
    });
    expect(applyCompletion("sel", 0, 3, "SELECT").caret).toBe(6);
  });
});

describe("wordsProvider", () => {
  it("suggests distinct document words, excluding the one being typed", async () => {
    const text = "alpha beta alphabet al gamma";
    const items = await wordsProvider().provideCompletions({
      text,
      offset: 22,
      prefix: "al",
      wordStart: 20,
      linePrefix: text.slice(0, 22),
      explicit: false,
    });
    expect(items.map((i) => i.label).sort()).toEqual(["alpha", "alphabet", "beta", "gamma"]);
  });
});
