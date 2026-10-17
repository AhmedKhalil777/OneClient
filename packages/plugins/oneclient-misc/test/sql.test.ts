import { describe, expect, it } from "vitest";
import { formatSql, lowercaseKeywords, sqlSymbols, sqlTokens, tokenize, uppercaseKeywords } from "../src/sql.js";

const fmt = (sql: string) => {
  const r = formatSql(sql);
  if (!r.ok) throw new Error(r.error.message);
  return r.text;
};

/** Token text with the case folded and all whitespace removed — formatting must never change this. */
const essence = (s: string) => tokenize(s).filter((t) => t.kind !== "ws").map((t) => (t.kind === "word" ? t.text.toUpperCase() : t.text)).join("\u0001");

describe("tokenizer", () => {
  it("handles strings with escaped quotes, bracket identifiers, comments and variables", () => {
    const toks = tokenize("SELECT N'it''s', [a]]b], @x, @@ROWCOUNT, 0xFF, 1.5e3 -- c\n/* a /* nested */ b */");
    expect(toks.filter((t) => t.kind !== "ws" && t.kind !== "punct").map((t) => [t.kind, t.text])).toEqual([
      ["word", "SELECT"],
      ["string", "N'it''s'"],
      ["quoted", "[a]]b]"],
      ["variable", "@x"],
      ["variable", "@@ROWCOUNT"],
      ["number", "0xFF"],
      ["number", "1.5e3"],
      ["lineComment", "-- c"],
      ["blockComment", "/* a /* nested */ b */"],
    ]);
  });

  it("tolerates unterminated strings and comments", () => {
    expect(() => tokenize("SELECT 'oops")).not.toThrow();
    expect(tokenize("/* open")[0]?.kind).toBe("blockComment");
  });
});

describe("highlighting", () => {
  it("classifies keywords, functions (only when called), types, strings, numbers, comments and variables", () => {
    const text = "SELECT COUNT(*), LEFT(a, 1) FROM t WHERE x = 'a' AND y > 10 -- hi\nDECLARE @v INT";
    const r = sqlTokens(text);
    if (!r.ok) throw new Error("not ok");
    const found = new Map<string, string>();
    for (let i = 0; i < r.tokens.length; i += 3) found.set(text.slice(r.tokens[i], r.tokens[i + 1]), r.classes[r.tokens[i + 2]!]!);
    expect(found.get("SELECT")).toBe("keyword");
    expect(found.get("COUNT")).toBe("function");
    expect(found.get("LEFT")).toBe("function");
    expect(found.get("AND")).toBe("operator");
    expect(found.get("'a'")).toBe("string");
    expect(found.get("10")).toBe("number");
    expect(found.get("-- hi")).toBe("comment");
    expect(found.get("@v")).toBe("variable");
    expect(found.get("INT")).toBe("type");
  });

  it("does not colour a name after a dot", () => {
    const text = "SELECT t.Count FROM t";
    const r = sqlTokens(text);
    if (!r.ok) throw new Error("not ok");
    const words = [];
    for (let i = 0; i < r.tokens.length; i += 3) words.push(text.slice(r.tokens[i], r.tokens[i + 1]));
    expect(words).not.toContain("Count");
  });
});

describe("outline", () => {
  const names = (sql: string) => {
    const r = sqlSymbols(sql);
    if (!r.ok) throw new Error("not ok");
    return r.symbols.map((s) => [s.name, s.detail, (s.children ?? []).map((c) => c.name)]);
  };

  it("lists statements with their targets", () => {
    expect(names("SELECT a FROM dbo.Users WHERE id = 1;\nINSERT INTO dbo.Log (a) VALUES (1);\nUPDATE dbo.Users SET a = 1\nDELETE FROM dbo.Users")).toEqual([
      ["SELECT", "FROM dbo.Users", []],
      ["INSERT INTO dbo.Log", undefined, []],
      ["UPDATE dbo.Users", undefined, []],
      ["DELETE FROM dbo.Users", undefined, []],
    ]);
  });

  it("splits batches on GO and nests a procedure's statements under it", () => {
    const sql = "CREATE TABLE [dbo].[T] (id INT)\nGO\nCREATE PROCEDURE dbo.GetT AS\nBEGIN\n  SELECT * FROM dbo.T\n  EXEC dbo.Other\nEND\nGO\nDROP TABLE dbo.T";
    expect(names(sql)).toEqual([
      ["CREATE TABLE [dbo].[T]", undefined, []],
      ["CREATE PROCEDURE dbo.GetT", undefined, ["SELECT", "EXEC dbo.Other"]],
      ["DROP TABLE dbo.T", undefined, []],
    ]);
  });

  it("keeps INSERT … SELECT, UNION and subqueries as one statement", () => {
    expect(names("INSERT INTO a SELECT * FROM b UNION ALL SELECT * FROM c;\nSELECT (SELECT 1) AS x")).toEqual([
      ["INSERT INTO a", undefined, []],
      ["SELECT", undefined, []],
    ]);
  });

  it("gives symbol ranges that point at the statement", () => {
    const sql = "SELECT 1;\nSELECT 2";
    const r = sqlSymbols(sql);
    if (!r.ok) throw new Error("not ok");
    expect(sql.slice(r.symbols[1]!.start, r.symbols[1]!.end)).toBe("SELECT 2");
  });
});

describe("keyword case", () => {
  it("changes only reserved words — never strings, comments, quoted names or names after a dot", () => {
    const sql = "select 'select', [select], t.select from t -- select\nwhere a = 1";
    const up = uppercaseKeywords(sql);
    expect(up.ok && up.text).toBe("SELECT 'select', [select], t.select FROM t -- select\nWHERE a = 1");
    const low = lowercaseKeywords("SELECT 'SELECT' FROM T");
    expect(low.ok && low.text).toBe("select 'SELECT' from T");
  });
});

describe("formatter", () => {
  it("puts clauses on their own lines and one select item per line", () => {
    expect(fmt("select a,b, count(*) as n from dbo.T t inner join U u on t.id=u.id and t.x=1 left outer join V on V.id = t.id where a=1 and b between 1 and 2 or c is null group by a,b having count(*)>1 order by a desc")).toBe(
      [
        "SELECT a,",
        "    b,",
        "    count(*) AS n",
        "FROM dbo.T t",
        "INNER JOIN U u",
        "    ON t.id=u.id",
        "    AND t.x=1",
        "LEFT OUTER JOIN V",
        "    ON V.id = t.id",
        "WHERE a=1",
        "    AND b BETWEEN 1 AND 2",
        "    OR c IS NULL",
        "GROUP BY a,",
        "    b",
        "HAVING count(*)>1",
        "ORDER BY a DESC",
        "",
      ].join("\n"),
    );
  });

  it("separates statements with a blank line and leaves GO on its own line", () => {
    expect(fmt("select 1; select 2\ngo\nselect 3")).toBe("SELECT 1;\n\nSELECT 2\nGO\n\nSELECT 3\n");
  });

  it("lays out CREATE TABLE columns one per line", () => {
    expect(fmt("create table dbo.T (id int not null primary key, name nvarchar(50), price decimal(10,2))")).toBe(
      "CREATE TABLE dbo.T (\n    id int NOT NULL PRIMARY KEY,\n    name nvarchar(50),\n    price decimal(10,2)\n)\n",
    );
  });

  it("keeps LEFT()/RIGHT() calls and CASE WHEN inline", () => {
    expect(fmt("select left(a,1), case when x=1 and y=2 then 'a' else 'b' end from t")).toBe("SELECT left(a,1),\n    CASE WHEN x=1 AND y=2 THEN 'a' ELSE 'b' END\nFROM t\n");
  });

  it("keeps comments where they are, including a line comment before the next clause", () => {
    expect(fmt("select a -- the a\nfrom t /* tbl */ where x=1")).toBe("SELECT a -- the a\nFROM t /* tbl */\nWHERE x=1\n");
  });

  it("keeps DELETE FROM together and UPDATE … SET on separate lines", () => {
    expect(fmt("delete from t where a=1\nupdate t set a=1, b=2 where c=3")).toBe("DELETE FROM t\nWHERE a=1\n\nUPDATE t\nSET a=1,\n    b=2\nWHERE c=3\n");
  });

  it("never changes what the script means (same tokens, ignoring whitespace and keyword case)", () => {
    const scripts = [
      "SELECT a,b FROM t WHERE x='a  b' AND y=[col  name] -- trailing\nORDER BY 1",
      "CREATE PROCEDURE p @x int AS BEGIN SET NOCOUNT ON; IF @x>1 SELECT 1 ELSE SELECT 2 END",
      "WITH c AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM c WHERE n<5) SELECT * FROM c OPTION (MAXRECURSION 0)",
      "MERGE t AS tgt USING s ON tgt.id=s.id WHEN MATCHED THEN UPDATE SET a=s.a WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id);",
      "INSERT INTO a(x) SELECT x FROM b; EXEC dbo.p @a=1, @b='x'",
    ];
    for (const s of scripts) expect(essence(fmt(s))).toBe(essence(s));
  });

  it("is idempotent", () => {
    const once = fmt("select a,b from t inner join u on t.id=u.id where x=1 and y=2; insert into z(a) values(1)");
    expect(fmt(once)).toBe(once);
  });

  it("uses tabs when asked and leaves an empty file alone", () => {
    const r = formatSql("select a,b from t", 4, false);
    expect(r.ok && r.text).toBe("SELECT a,\n\tb\nFROM t\n");
    expect(formatSql("  ").ok).toBe(true);
  });
});
