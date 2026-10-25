import { describe, expect, it } from "vitest";
import { textArray } from "../src/table-access.js";

describe("textArray", () => {
  it("takes a real array as is", () => {
    expect(textArray(["a", "b"])).toEqual(["a", "b"]);
  });
  it("reads the text form a pool configured for strings returns", () => {
    expect(textArray("{order_id}")).toEqual(["order_id"]);
    expect(textArray("{a,b,c}")).toEqual(["a", "b", "c"]);
    expect(textArray("{}")).toEqual([]);
  });
  it("unquotes elements with spaces, commas and quotes", () => {
    expect(textArray('{"first name","a,b","say \\"hi\\""}')).toEqual(["first name", "a,b", 'say "hi"']);
  });
  it("is empty for anything else", () => {
    expect(textArray(null)).toEqual([]);
    expect(textArray(42)).toEqual([]);
  });
});
