import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "../src/faker/schema.js";
import { suggestRule, textCapacity } from "../src/faker/suggest.js";

const col = (over: Partial<ColumnInfo>): ColumnInfo => ({
  name: "x",
  type: "nvarchar",
  maxLength: 200,
  precision: 0,
  scale: 0,
  nullable: false,
  identity: false,
  computed: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  unsupported: false,
  ...over,
});

describe("faker suggestions (like Bogus RuleFor, but automatic)", () => {
  it("picks generators from column names", () => {
    const k = (name: string, type = "nvarchar") => {
      const r = suggestRule(col({ name, type }));
      return r.kind === "faker" ? r.fakerId : r.kind;
    };
    expect(k("Email")).toBe("internet.email");
    expect(k("first_name")).toBe("person.firstName");
    expect(k("LastName")).toBe("person.lastName");
    expect(k("phone_number")).toBe("phone.number");
    expect(k("City")).toBe("location.city");
    expect(k("zip")).toBe("location.zipCode");
    expect(k("CompanyName")).toBe("company.name");
    expect(k("website")).toBe("internet.url");
    expect(k("something_else")).toBe("text");
  });

  it("uses types for the rest, and leaves identity / computed columns alone", () => {
    expect(suggestRule(col({ name: "id", type: "int", identity: true, primaryKey: true })).kind).toBe("skip");
    expect(suggestRule(col({ name: "rv", type: "timestamp", computed: true })).kind).toBe("skip");
    expect(suggestRule(col({ name: "is_active", type: "bit" })).kind).toBe("boolean");
    expect(suggestRule(col({ name: "guid", type: "uniqueidentifier" })).kind).toBe("guid");
    expect(suggestRule(col({ name: "created_at", type: "datetime2" }))).toMatchObject({ kind: "faker", fakerId: "date.past" });
    expect(suggestRule(col({ name: "qty", type: "int" }))).toMatchObject({ kind: "integer", min: 1, max: 100 });
    expect(suggestRule(col({ name: "price", type: "decimal", precision: 8, scale: 2 }))).toMatchObject({ kind: "decimal", decimals: 2 });
  });

  it("continues an existing integer key and maps foreign keys to existing rows", () => {
    expect(suggestRule(col({ name: "id", type: "int", primaryKey: true, maxValue: 41 }))).toMatchObject({ kind: "sequence", start: 42, step: 1 });
    expect(suggestRule(col({ name: "customer_id", type: "int", fk: { constraint: "FK", schema: "dbo", table: "Customers", column: "id" } })).kind).toBe("fk-existing");
  });

  it("doesn't put paragraphs into short columns", () => {
    expect(suggestRule(col({ name: "description", type: "nvarchar", maxLength: 40 }))).toMatchObject({ kind: "faker", fakerId: "lorem.words" });
    expect(textCapacity({ type: "nvarchar", maxLength: 100 })).toBe(50);
    expect(textCapacity({ type: "varchar", maxLength: -1 })).toBe(4000);
  });
});
