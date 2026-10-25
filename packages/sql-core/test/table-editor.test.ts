import { describe, expect, it } from "vitest";
import { BATCH_ROWS, EditError, buildStatements, checkWhere, literal, reviewScript } from "../src/table-editor/sql.js";
import type { Change, TableAccess, TableColumn, TableTarget } from "../src/table-editor/types.js";

const pg: TableAccess = {
  quote: (n) => `"${n.replace(/"/g, '""')}"`,
  qualify: (t) => `"${t.schema}"."${t.table}"`,
  literals: { string: "", bool: { true: "true", false: "false" } },
  describe: async () => [],
  fetchPage: async () => [],
  estimateRows: async () => null,
  apply: async () => undefined,
};
const mssql: TableAccess = { ...pg, quote: (n) => `[${n}]`, qualify: (t) => `[${t.schema}].[${t.table}]`, literals: { string: "N", bool: { true: "1", false: "0" } } };

const col = (name: string, over: Partial<TableColumn> = {}): TableColumn => ({ name, type: "text", kind: "text", nullable: true, isPk: false, hasDefault: false, insertable: true, editable: true, ...over });
const columns: TableColumn[] = [
  col("id", { type: "int", kind: "number", nullable: false, isPk: true, hasDefault: true, editable: false }),
  col("name", { nullable: false }),
  col("age", { type: "int", kind: "number" }),
  col("active", { type: "bit", kind: "bool" }),
  col("meta", { type: "json", kind: "json" }),
  col("blob", { type: "varbinary", kind: "binary", editable: false }),
];
const target: TableTarget = { database: "shop", schema: "dbo", table: "customers" };

describe("literals", () => {
  it("quotes strings (with the dialect's prefix), validates numbers and booleans", () => {
    expect(literal("O'Brien", columns[1]!, pg)).toBe("'O''Brien'");
    expect(literal("Ünï", columns[1]!, mssql)).toBe("N'Ünï'");
    expect(literal(" 42 ", columns[2]!, pg)).toBe("42");
    expect(literal("-1.5e3", columns[2]!, pg)).toBe("-1.5e3");
    expect(() => literal("4 2; DROP TABLE x", columns[2]!, pg)).toThrow(/not a number/);
    expect(literal("Yes", columns[3]!, mssql)).toBe("1");
    expect(literal("false", columns[3]!, pg)).toBe("false");
    expect(() => literal("maybe", columns[3]!, pg)).toThrow(/true or false/);
    expect(literal(null, columns[2]!, pg)).toBe("NULL");
    expect(() => literal(null, columns[1]!, pg)).toThrow(/doesn't accept NULL/);
    expect(() => literal("{oops", columns[4]!, pg)).toThrow(/valid JSON/);
    expect(literal('{"a":1}', columns[4]!, pg)).toBe(`'{"a":1}'`);
    expect(() => literal("a\0b", columns[1]!, pg)).toThrow(/NUL/);
  });
});

describe("string escaping per dialect", () => {
  const mysql: TableAccess = { ...pg, literals: { string: "", bool: { true: "TRUE", false: "FALSE" }, escape: (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "''") } };
  it("lets a dialect escape more than the quote (MySQL reads backslash as an escape)", () => {
    const text = String.raw`C:\new\table's`;
    expect(literal(text, columns[1]!, pg)).toBe(String.raw`'C:\new\table''s'`); // standard SQL: backslash is just a character
    expect(literal(text, columns[1]!, mysql)).toBe(String.raw`'C:\\new\\table''s'`);
  });
});

describe("statements for staged changes", () => {
  it("builds an UPDATE by primary key, and refuses columns the database owns or that can't be edited", () => {
    const sql = buildStatements(target, columns, [{ kind: "update", key: { id: 7 }, set: { name: "Ann", age: null, active: "true" } }], pg);
    expect(sql).toEqual([{ sql: `UPDATE "dbo"."customers" SET "name" = 'Ann', "age" = NULL, "active" = true WHERE "id" = 7`, expect: 1 }]);
    expect(() => buildStatements(target, columns, [{ kind: "update", key: { id: 7 }, set: { id: "8" } }], pg)).toThrow(EditError);
    expect(() => buildStatements(target, columns, [{ kind: "update", key: { id: 7 }, set: { blob: "x" } }], pg)).toThrow(/can't be edited/);
  });

  it("matches composite keys and refuses tables without one", () => {
    const composite = [col("a", { kind: "number", isPk: true, nullable: false }), col("b", { isPk: true, nullable: false }), col("v")];
    const sql = buildStatements(target, composite, [{ kind: "update", key: { a: 1, b: "x" }, set: { v: "y" } }, { kind: "delete", key: { a: 2, b: "z" } }], pg);
    expect(sql.map((s) => s.sql)).toEqual([`UPDATE "dbo"."customers" SET "v" = 'y' WHERE "a" = 1 AND "b" = 'x'`, `DELETE FROM "dbo"."customers" WHERE "a" = 2 AND "b" = 'z'`]);
    expect(() => buildStatements(target, [col("v")], [{ kind: "delete", key: {} }], pg)).toThrow(/no primary key/);
  });

  it("batches inserts of the same shape and deletes by one key column", () => {
    const changes: Change[] = [
      { kind: "insert", values: { name: "A", age: "1" } },
      { kind: "insert", values: { name: "B", age: "2" } },
      { kind: "insert", values: { name: "C" } },
      { kind: "insert", values: {} },
      { kind: "delete", key: { id: 1 } },
      { kind: "delete", key: { id: 2 } },
    ];
    const sql = buildStatements(target, columns, changes, mssql);
    expect(sql).toEqual([
      { sql: `INSERT INTO [dbo].[customers] ([name], [age]) VALUES (N'A', 1), (N'B', 2)`, expect: 2 },
      { sql: `INSERT INTO [dbo].[customers] ([name]) VALUES (N'C')`, expect: 1 },
      { sql: `INSERT INTO [dbo].[customers] DEFAULT VALUES`, expect: 1 },
      { sql: `DELETE FROM [dbo].[customers] WHERE [id] IN (1, 2)`, expect: 2 },
    ]);
    expect(() => buildStatements(target, [col("id", { isPk: true, insertable: false, kind: "number" })], [{ kind: "insert", values: { id: "1" } }], pg)).toThrow(/filled in by the database/);
  });

  it("turns thousands of deletes into a few statements", () => {
    const deletes: Change[] = Array.from({ length: BATCH_ROWS * 2 + 3 }, (_, i) => ({ kind: "delete", key: { id: i } }));
    const sql = buildStatements(target, columns, deletes, pg);
    expect(sql.map((s) => s.expect)).toEqual([BATCH_ROWS, BATCH_ROWS, 3]);
  });

  it("writes the review script with ; and rejects filters that could smuggle a second statement", () => {
    expect(reviewScript([{ sql: "DELETE FROM t WHERE id = 1", expect: 1 }, { sql: "DELETE FROM t WHERE id = 2", expect: 1 }])).toBe("DELETE FROM t WHERE id = 1;\nDELETE FROM t WHERE id = 2;");
    expect(checkWhere("  age > 3 AND name LIKE 'a%' ")).toBe("age > 3 AND name LIKE 'a%'");
    expect(checkWhere("   ")).toBeUndefined();
    for (const bad of ["1=1; DROP TABLE t", "a = 1 -- x", "a = /* x */ 1"]) expect(() => checkWhere(bad)).toThrow(/condition only/);
  });
});
