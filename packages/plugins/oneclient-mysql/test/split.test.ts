import { describe, expect, it } from "vitest";
import { splitStatements } from "../src/split.js";

const texts = (s: string) => splitStatements(s).map((x) => x.text);

describe("MySQL statement splitter", () => {
  it("splits on semicolons and reports the line of each statement's first token", () => {
    const parts = splitStatements("SELECT 1;\n\n  -- note\nSELECT 2;\nUPDATE t SET a = 1\n WHERE b = 2;");
    expect(parts.map((p) => p.text)).toEqual(["SELECT 1;".slice(0, -1), "SELECT 2", "UPDATE t SET a = 1\n WHERE b = 2"]);
    expect(parts.map((p) => p.startLine)).toEqual([1, 4, 5]);
  });

  it("ignores semicolons in strings (with backslash escapes and doubled quotes), identifiers and comments", () => {
    expect(texts(`SELECT 'a;b', "c;d", \`e;f\`; SELECT 'it''s;', 'x\\';y'; -- ; hi\n# ; there\nSELECT /* ; */ 3;`)).toEqual([`SELECT 'a;b', "c;d", \`e;f\``, `SELECT 'it''s;', 'x\\';y'`, "SELECT /* ; */ 3"]);
  });

  it("treats -- as a comment only when a space follows", () => {
    expect(texts("SELECT 5--3; SELECT 1")).toEqual(["SELECT 5--3", "SELECT 1"]);
    expect(texts("SELECT 1 -- ; x\n, 2;")).toEqual(["SELECT 1 -- ; x\n, 2"]);
  });

  it("follows DELIMITER, so a stored program's body stays in one statement", () => {
    const script = "DELIMITER //\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND//\nDELIMITER ;\nCALL p();";
    const parts = splitStatements(script);
    expect(parts.map((p) => p.text)).toEqual(["CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND", "CALL p()"]);
    expect(parts.map((p) => p.startLine)).toEqual([2, 8]);
  });

  it("drops comment-only and empty statements, and keeps executable /*! */ comments", () => {
    expect(texts(";; -- nothing\n; /* x */ ;")).toEqual([]);
    expect(texts("/*!40101 SET @x = 1 */;")).toEqual(["/*!40101 SET @x = 1 */"]);
  });
});
