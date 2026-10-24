import { describe, expect, it } from "vitest";
import { type ResultSet, compareValues, pick, prettyValue, toCsv, toInserts, toJson, toMarkdown, toTsv, viewOrder } from "../src/sql/data.js";
import { findRiskyStatements } from "../src/sql/guard.js";

const rs: ResultSet = {
  columns: [
    { name: "id", type: "int8" },
    { name: "name", type: "text" },
    { name: "meta", type: "jsonb" },
  ],
  rows: [
    ["10", "Linus", '{"plan":"pro"}'],
    ["9", "ada", null],
    ["100", 'Grace "Amazing"', '{"tags":[1,2]}'],
    [null, "Ana, Jr.", "{}"],
  ],
  totalRows: 4,
};

describe("ordering and filtering", () => {
  it("sorts numeric strings by value, NULLs last, text naturally", () => {
    expect(viewOrder(rs, "", { col: 0, desc: false })).toEqual([1, 0, 2, 3]);
    expect(viewOrder(rs, "", { col: 0, desc: true })).toEqual([2, 0, 1, 3]);
    expect(viewOrder(rs, "", { col: 1, desc: false }).map((i) => rs.rows[i]![1])).toEqual(["ada", "Ana, Jr.", 'Grace "Amazing"', "Linus"]);
    expect(compareValues("file2", "file10")).toBeLessThan(0);
  });

  it("filters any column, or one column with name:value", () => {
    expect(viewOrder(rs, "pro", null)).toEqual([0]);
    expect(viewOrder(rs, "name:a", null)).toEqual([1, 2, 3]);
    expect(viewOrder(rs, "null", null)).toEqual([1, 3]);
  });

  it("picks a rectangle in view order", () => {
    const order = viewOrder(rs, "", { col: 0, desc: false });
    expect(pick(rs, order, { r0: 1, c0: 1, r1: 0, c1: 0 })).toEqual({ columns: rs.columns.slice(0, 2), rows: [["9", "ada"], ["10", "Linus"]] });
  });
});

describe("formats", () => {
  it("CSV quotes what needs quoting and leaves NULL empty", () => {
    expect(toCsv(rs.columns, rs.rows)).toBe('id,name,meta\r\n10,Linus,"{""plan"":""pro""}"\r\n9,ada,\r\n100,"Grace ""Amazing""","{""tags"":[1,2]}"\r\n,"Ana, Jr.",{}\r\n');
  });

  it("TSV spells NULL and flattens line breaks", () => {
    expect(toTsv(null, [["a\nb", null]])).toBe("a b\tNULL");
  });

  it("JSON keeps json columns structured", () => {
    const parsed = JSON.parse(toJson(rs.columns, rs.rows));
    expect(parsed[0]).toEqual({ id: "10", name: "Linus", meta: { plan: "pro" } });
    expect(parsed[1].meta).toBeNull();
  });

  it("Markdown escapes pipes", () => {
    expect(toMarkdown([{ name: "a|b", type: "text" }], [["x|y"]])).toBe("| a\\|b |\n| --- |\n| x\\|y |\n");
  });

  it("INSERTs quote per dialect and batch by 1,000 rows", () => {
    expect(toInserts(rs.columns.slice(0, 2), [[1, "O'Brien"], [null, true]], "public.people", "postgres")).toBe(
      `INSERT INTO "public"."people" ("id", "name") VALUES\n    (1, 'O''Brien'),\n    (NULL, TRUE);\n`,
    );
    expect(toInserts([{ name: "n", type: "nvarchar" }], [["Zoë"], [false]], "dbo.t", "mssql")).toBe(`INSERT INTO [dbo].[t] ([n]) VALUES\n    (N'Zoë'),\n    (0);\n`);
    const many = Array.from({ length: 2500 }, (_, i) => [i]);
    expect(toInserts([{ name: "i", type: "int" }], many, "t", "mssql").match(/INSERT INTO/g)).toHaveLength(3);
  });

  it("pretty-prints JSON for the cell viewer", () => {
    expect(prettyValue('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true });
    expect(prettyValue("{not json")).toEqual({ text: "{not json", json: false });
    expect(prettyValue(null).text).toBe("NULL");
  });
});

describe("safe mode", () => {
  const kinds = (sql: string) => findRiskyStatements(sql).map((r) => r.kind);

  it("flags data-wide changes and drops", () => {
    expect(kinds("DELETE FROM orders")).toEqual(["delete-all"]);
    expect(kinds("update users set active = false;")).toEqual(["update-all"]);
    expect(kinds("TRUNCATE TABLE logs")).toEqual(["truncate"]);
    expect(kinds("DROP TABLE IF EXISTS t")).toEqual(["drop"]);
    expect(kinds("ALTER TABLE t DROP COLUMN c")).toEqual(["alter-drop"]);
    expect(kinds("WITH x AS (SELECT 1) DELETE FROM t")).toEqual(["delete-all"]);
  });

  it("lets targeted statements through", () => {
    expect(kinds("DELETE FROM orders WHERE id = 1")).toEqual([]);
    expect(kinds("UPDATE t SET a = 1 WHERE b = 2")).toEqual([]);
    expect(kinds("SELECT * FROM t; INSERT INTO t VALUES (1)")).toEqual([]);
    expect(kinds("ALTER TABLE t ADD COLUMN c int")).toEqual([]);
  });

  it("ignores keywords in comments, strings and dollar quotes", () => {
    expect(kinds("-- DELETE FROM orders\nSELECT 1")).toEqual([]);
    expect(kinds("SELECT 'DROP TABLE x' AS s")).toEqual([]);
    expect(kinds("/* TRUNCATE t */ SELECT 1")).toEqual([]);
    expect(kinds("DO $$ BEGIN DELETE FROM t; END $$;")).toEqual([]);
    // a WHERE inside a string doesn't make a DELETE targeted
    expect(kinds("DELETE FROM t -- WHERE id = 1")).toEqual(["delete-all"]);
  });

  it("splits SQL Server batches on GO", () => {
    expect(kinds("UPDATE t SET a = 1 WHERE id = 2\nGO\nDELETE FROM t\nGO")).toEqual(["delete-all"]);
  });
});

describe("guessTables", () => {
  it("finds each SELECT's first table", async () => {
    const { guessTables } = await import("../src/sql/data.js");
    expect(guessTables(`SELECT * FROM public.orders o JOIN x ON 1=1; UPDATE t SET a=1 WHERE b=2; SELECT 1;\nselect * from "My Table"`)).toEqual(["public.orders", undefined, "My Table"]);
    expect(guessTables("SELECT * FROM generate_series(1, 5) g")).toEqual([undefined]);
    expect(guessTables("SELECT TOP 10 * FROM [erd_demo].[sales].[orders]\nGO\nSELECT name FROM sys.tables")).toEqual(["sales.orders", "sys.tables"]);
  });
});
