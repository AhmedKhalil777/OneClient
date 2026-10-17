import { describe, expect, it } from "vitest";
import { readFakerFile, splitTableName, writeFakerFile } from "../src/faker/fakerfile.js";

describe("faker files (*.faker.json)", () => {
  it("parses table names with or without schema and brackets", () => {
    expect(splitTableName("dbo.Customers")).toEqual({ schema: "dbo", table: "Customers" });
    expect(splitTableName("Customers")).toEqual({ schema: "dbo", table: "Customers" });
    expect(splitTableName("[sales].[Order Lines]")).toEqual({ schema: "sales", table: "Order Lines" });
  });

  it("reads a minimal hand-written file: defaults for name and count, nested children", () => {
    const doc = readFakerFile({
      table: "Customers",
      children: [{ table: "dbo.Orders", via: "customer_id", children: [{ table: "OrderLines", via: "order_id", min: 2, max: 4 }] }],
    });
    expect(doc).toMatchObject({ name: "Customers faker", count: 100, rule: { schema: "dbo", table: "Customers", columns: [] } });
    expect(doc.rule.children?.[0]).toMatchObject({ table: "Orders", via: "customer_id", min: 1, max: 3 });
    expect(doc.rule.children?.[0]?.children?.[0]).toMatchObject({ table: "OrderLines", via: "order_id", min: 2, max: 4 });
  });

  it("round-trips a full faker, including FK parents and children", () => {
    const original = {
      name: "Shop",
      database: "Shop",
      count: 20,
      seed: 3,
      rule: {
        schema: "dbo",
        table: "Orders",
        columns: [
          { column: "status", kind: "pick" as const, value: "new, paid" },
          { column: "customer_id", kind: "fk-new" as const, parentCount: 4, parent: { schema: "dbo", table: "Customers", columns: [{ column: "email", kind: "faker" as const, fakerId: "internet.email" }] } },
        ],
        children: [{ schema: "dbo", table: "OrderLines", via: "order_id", min: 1, max: 5, columns: [] }],
      },
    };
    const file = writeFakerFile(original);
    expect(file).toMatchObject({ format: "oneclient-faker", version: 1, table: "dbo.Orders", columns: { status: { kind: "pick", value: "new, paid" } } });
    expect(readFakerFile(JSON.parse(JSON.stringify(file)))).toEqual(original);
  });

  it("explains bad files and refuses newer versions", () => {
    expect(() => readFakerFile([])).toThrow(/not a JSON object/);
    expect(() => readFakerFile({ columns: {} })).toThrow(/"table" is missing/);
    expect(() => readFakerFile({ table: "T", columns: { a: { kind: "weird" } } })).toThrow(/unknown kind/);
    expect(() => readFakerFile({ table: "T", children: [{ table: "C" }] })).toThrow(/"via"/);
    expect(() => readFakerFile({ format: "something-else", table: "T" })).toThrow(/not a oneClient faker/);
    expect(() => readFakerFile({ format: "oneclient-faker", version: 99, table: "T" })).toThrow(/newer version/);
  });
});
