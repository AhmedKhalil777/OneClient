import { describe, expect, it } from "vitest";
import { findMatches, replaceAll, replacementFor } from "../src/editor/find.js";

const plain = { caseSensitive: false, wholeWord: false, regex: false };

describe("find", () => {
  it("finds plain text case-insensitively, with regex characters taken literally", () => {
    const { matches } = findMatches("a.b A.B axb", "a.b", plain);
    expect(matches).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
    expect(findMatches("a.b A.B", "a.b", { ...plain, caseSensitive: true }).matches).toHaveLength(1);
  });

  it("matches whole words and regexes, and reports bad regexes", () => {
    expect(findMatches("cat concat cat_x cat", "cat", { ...plain, wholeWord: true }).matches.map((m) => m.start)).toEqual([0, 17]);
    expect(findMatches("id1 id22 x", "id\\d+", { ...plain, regex: true }).matches).toHaveLength(2);
    expect(findMatches("x", "(", { ...plain, regex: true }).error).toBeTruthy();
    // ^ matches empty strings: skipped, and the loop still ends
    expect(findMatches("a\nb", "^", { ...plain, regex: true }).matches).toEqual([]);
    expect(findMatches("ab\nab", "^ab", { ...plain, regex: true }).matches).toHaveLength(2);
  });

  it("replaces all in one pass, expanding groups in regex mode", () => {
    expect(replaceAll("foo foo", "foo", "foofoo", plain)).toEqual({ text: "foofoo foofoo", count: 2 });
    expect(replaceAll("John Smith, Ada Lovelace", "(\\w+) (\\w+)", "$2 $1", { ...plain, regex: true }).text).toBe("Smith John, Lovelace Ada");
    expect(replacementFor("x=12", { start: 2, end: 4 }, "(\\d)(\\d)", "$2$1", { ...plain, regex: true })).toBe("21");
    expect(replaceAll("abc", "z", "y", plain)).toEqual({ text: "abc", count: 0 });
  });
});
