import { describe, expect, it } from "vitest";
import { fromInputValue, htmlInput, inputKindOf, toInputValue } from "../ui/inputs.js";

const col = (type: string, kind: string, lob = false) => ({ type, kind, lob });

describe("inputKindOf", () => {
  it("tells whole numbers from fractions", () => {
    for (const t of ["int", "integer", "bigint", "smallint", "tinyint", "int4", "int(11)", "bigint unsigned", "serial", "bigserial"]) expect(inputKindOf(col(t, "number")).kind, t).toBe("integer");
    for (const t of ["numeric(10,2)", "decimal(18,4)", "double precision", "float", "real", "money"]) expect(inputKindOf(col(t, "number")).kind, t).toBe("decimal");
  });
  it("tells dates, times and timestamps apart, and whether they carry a zone", () => {
    expect(inputKindOf(col("date", "date")).kind).toBe("date");
    expect(inputKindOf(col("time", "date")).kind).toBe("time");
    expect(inputKindOf(col("time without time zone", "date")).kind).toBe("time");
    expect(inputKindOf(col("timestamp without time zone", "date"))).toEqual({ kind: "datetime", zoned: false });
    expect(inputKindOf(col("timestamp with time zone", "date"))).toEqual({ kind: "datetime", zoned: true });
    expect(inputKindOf(col("datetimeoffset", "date"))).toEqual({ kind: "datetime", zoned: true });
    expect(inputKindOf(col("datetime2", "date"))).toEqual({ kind: "datetime", zoned: false });
    expect(inputKindOf(col("datetime(6)", "date"))).toEqual({ kind: "datetime", zoned: false });
    expect(inputKindOf(col("interval", "date")).kind).toBe("text");
  });
  it("picks bool, json, multiline and text", () => {
    expect(inputKindOf(col("boolean", "bool")).kind).toBe("bool");
    expect(inputKindOf(col("jsonb", "json")).kind).toBe("json");
    expect(inputKindOf(col("text", "text", true)).kind).toBe("text"); // large-flagged text is still a one-line box
    expect(inputKindOf(col("varchar(50)", "text")).kind).toBe("text");
  });
});

describe("html input types", () => {
  it("maps each kind", () => {
    expect(htmlInput({ kind: "integer" })).toEqual({ type: "number", step: "1" });
    expect(htmlInput({ kind: "decimal" })).toEqual({ type: "number", step: "any" });
    expect(htmlInput({ kind: "datetime", zoned: false })).toEqual({ type: "datetime-local", step: "1" });
    expect(htmlInput({ kind: "date" })).toEqual({ type: "date" });
    expect(htmlInput({ kind: "text" })).toEqual({ type: "text" });
  });
});

describe("value conversion", () => {
  const naive = { kind: "datetime", zoned: false } as const;
  const zoned = { kind: "datetime", zoned: true } as const;

  it("shows a naive timestamp as written", () => {
    expect(toInputValue(naive, "2024-05-01 10:30:00")).toBe("2024-05-01T10:30:00");
    expect(toInputValue(naive, "2024-05-01T10:30")).toBe("2024-05-01T10:30:00");
    expect(toInputValue(naive, "2024-05-01 10:30:00.123")).toBe("2024-05-01T10:30:00");
  });
  it("shows an instant in local time and writes it back as an instant", () => {
    const instant = new Date(2024, 4, 1, 10, 30, 0); // local wall clock, whatever the zone
    const shown = toInputValue(zoned, instant.toISOString());
    expect(shown).toBe("2024-05-01T10:30:00");
    expect(new Date(fromInputValue(zoned, shown)).getTime()).toBe(instant.getTime());
  });
  it("writes a naive timestamp the way databases read it", () => {
    expect(fromInputValue(naive, "2024-05-01T10:30")).toBe("2024-05-01 10:30:00");
    expect(fromInputValue(naive, "2024-05-01T10:30:15")).toBe("2024-05-01 10:30:15");
  });
  it("handles dates and times", () => {
    expect(toInputValue({ kind: "date" }, "2024-05-01")).toBe("2024-05-01");
    expect(toInputValue({ kind: "date" }, new Date(2024, 4, 1).toISOString())).toBe("2024-05-01");
    expect(toInputValue({ kind: "time" }, "10:30:15.5")).toBe("10:30:15");
    expect(toInputValue({ kind: "time" }, "10:30")).toBe("10:30:00");
    expect(fromInputValue({ kind: "time" }, "10:30")).toBe("10:30:00");
  });
  it("leaves unreadable values and other kinds alone", () => {
    expect(toInputValue(naive, "not a date")).toBe("");
    expect(toInputValue({ kind: "integer" }, "42")).toBe("42");
    expect(fromInputValue({ kind: "integer" }, "42")).toBe("42");
    expect(fromInputValue(naive, "")).toBe("");
  });
});
