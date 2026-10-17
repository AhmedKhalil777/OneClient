import { describe, expect, it } from "vitest";
import { SSL_REQUIRE, defaultDatabase, describeConnection, pgTypes, quoteIdent, toClientConfig } from "../src/config.js";
import { parseArray } from "../src/metadata.js";
import { formatError, serializeValue, splitStatements } from "../src/query-runner.js";
import { quoteIfNeeded, tableReferences, unquote } from "../src-ui/completion.js";
import { highlightSql } from "../src-ui/highlight.js";

describe("connection settings", () => {
  it("builds a client config from the fields, preferring IPv4 for localhost", () => {
    const c = toClientConfig({ host: "localhost", port: 15432, user: "app", password: "pw", ssl: SSL_REQUIRE }, "shop");
    expect(c).toMatchObject({ host: "127.0.0.1", port: 15432, user: "app", database: "shop", ssl: { rejectUnauthorized: false }, application_name: "oneClient" });
    expect(toClientConfig({ host: "db" })).toMatchObject({ port: 5432, user: "postgres", database: "postgres", ssl: false });
    expect(() => toClientConfig({})).toThrow(/Host/);
  });

  it("accepts a connection string and switches its database", () => {
    const c = toClientConfig({ connectionString: "postgresql://u:p%40ss@localhost:6543/app?sslmode=require" }, "other");
    expect(c.connectionString).toBe("postgresql://u:p%40ss@127.0.0.1:6543/other");
    expect(c.ssl).toEqual({ rejectUnauthorized: false });
    expect(defaultDatabase({ connectionString: "postgres://h/app" })).toBe("app");
    expect(describeConnection({ connectionString: "postgres://me@h:6543/app" })).toEqual({ server: "h:6543", login: "me" });
    expect(() => toClientConfig({ connectionString: "mysql://h/db" })).toThrow(/postgres:\/\//);
  });

  it("keeps server text except plain numbers and booleans", () => {
    expect(pgTypes.getTypeParser(23)("42")).toBe(42);
    expect(pgTypes.getTypeParser(16)("t")).toBe(true);
    expect(pgTypes.getTypeParser(20)("9007199254740993")).toBe("9007199254740993"); // int8 stays exact
    expect(pgTypes.getTypeParser(1184)("2026-10-18 09:30:00+02")).toBe("2026-10-18 09:30:00+02");
    expect(serializeValue(true)).toBe("true");
    expect(serializeValue(null)).toBeNull();
  });

  it("quotes identifiers only when needed", () => {
    expect(quoteIdent("orders")).toBe("orders");
    expect(quoteIdent("Invoices")).toBe('"Invoices"');
    expect(quoteIdent("order")).toBe('"order"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe("query results", () => {
  it("maps the error position to an editor line, psql style", () => {
    const sql = "SELECT 1;\n\nSELECT nope FROM t;";
    const m = formatError({ message: 'column "nope" does not exist', code: "42703", severity: "ERROR", position: String(sql.indexOf("nope") + 1), hint: "Perhaps you meant x." }, sql, 5);
    expect(m.line).toBe(7);
    expect(m.text).toBe('ERROR:  column "nope" does not exist\nHINT:  Perhaps you meant x.\nSQL state: 42703, Line 7');
  });

  it("splits scripts into statements, keeping quotes, bodies and comments whole", () => {
    const script = [
      "SELECT 'a;b', \"x;y\" FROM t; -- c;",
      "",
      "CREATE FUNCTION f() RETURNS int AS $fn$ BEGIN RETURN 1; END $fn$ LANGUAGE plpgsql;",
      "/* one; /* nested; */ two; */ SELECT E'it\\'s;';",
      "CREATE FUNCTION g(a int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END; SELECT 2; END;",
      "SELECT $$x;$$, $1",
    ].join("\n");
    const parts = splitStatements(script);
    expect(parts.map((p) => p.startLine)).toEqual([1, 3, 4, 5, 6]);
    expect(parts[0]!.text).toBe("SELECT 'a;b', \"x;y\" FROM t;");
    expect(parts[1]!.text).toMatch(/^CREATE FUNCTION f\(\).*plpgsql;$/);
    expect(parts[2]!.text).toBe("/* one; /* nested; */ two; */ SELECT E'it\\'s;';");
    expect(parts[3]!.text).toMatch(/BEGIN ATOMIC .* END;$/);
    expect(parts[4]!.text).toBe("SELECT $$x;$$, $1");
    expect(splitStatements("-- only a comment;\n  ")).toEqual([]);
  });

  it("parses array literals", () => {
    expect(parseArray('{a,"b c",NULL,"q\\"x"}')).toEqual(["a", "b c", "NULL", 'q"x']);
    expect(parseArray("{}")).toEqual([]);
  });
});

describe("editor", () => {
  it("finds table references and aliases with PostgreSQL case folding", () => {
    const refs = tableReferences('SELECT * FROM sales."Invoices" i JOIN Customers AS c ON c.id = i.cid WHERE');
    expect(refs.get("i")).toEqual(["sales", "Invoices"]);
    expect(refs.get("c")).toEqual(["customers"]);
    expect(refs.has("where")).toBe(false);
    expect(unquote('"MixedCase"')).toBe("MixedCase");
    expect(quoteIfNeeded("Invoices")).toBe('"Invoices"');
    expect(quoteIfNeeded("user")).toBe('"user"');
  });

  it("highlights dollar-quoted bodies, casts and parameters", () => {
    const html = highlightSql("SELECT $1::int, 'x' -- c\nCREATE FUNCTION f() RETURNS int AS $fn$ SELECT 1 $fn$");
    expect(html).toContain('<span class="t-var">$1</span><span class="t-op">::</span><span class="t-type">int</span>');
    expect(html).toContain('<span class="t-string">$fn$ SELECT 1 $fn$</span>');
    expect(html).toContain('<span class="t-comment">-- c</span>');
  });
});
