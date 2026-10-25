import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCsvParser, detectDelimiter, detectEncoding, parseCsv, readCsvRows, sampleCsv } from "../src/import/csv.js";

/** Every way of cutting the text into chunks must give the same rows as parsing it whole. */
function chunked(text: string, delimiter: string, size: number): string[][] {
  const p = createCsvParser(delimiter);
  const out: string[][] = [];
  for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
  return [...out, ...p.end()];
}

describe("CSV parser", () => {
  it("reads plain rows with LF, CRLF and CR line breaks, with or without a final break", () => {
    const rows = [["id", "name"], ["1", "Ann"], ["2", "Bob"]];
    expect(parseCsv("id,name\n1,Ann\n2,Bob\n", ",")).toEqual(rows);
    expect(parseCsv("id,name\r\n1,Ann\r\n2,Bob", ",")).toEqual(rows);
    expect(parseCsv("id,name\r1,Ann\r2,Bob\r", ",")).toEqual(rows);
  });

  it("handles quotes: delimiters, line breaks and doubled quotes inside a quoted field", () => {
    const text = 'a,"b,c","line1\nline2","say ""hi""",""\n"x",y,"",z,w\n';
    expect(parseCsv(text, ",")).toEqual([
      ["a", "b,c", "line1\nline2", 'say "hi"', ""],
      ["x", "y", "", "z", "w"],
    ]);
  });

  it("keeps empty fields, skips blank lines, and keeps a row that is only an empty quoted value", () => {
    expect(parseCsv("a,,c\n,,\n\n\nd,e,\n", ",")).toEqual([["a", "", "c"], ["", "", ""], ["d", "e", ""]]);
    expect(parseCsv('""\nx\n', ",")).toEqual([[""], ["x"]]);
    expect(parseCsv("a,b", ",")).toEqual([["a", "b"]]);
    expect(parseCsv("", ",")).toEqual([]);
  });

  it("treats a quote in the middle of an unquoted field literally", () => {
    expect(parseCsv('5" pipe,ok\n', ",")).toEqual([['5" pipe', "ok"]]);
  });

  it("gives the same rows however the text is cut into chunks", () => {
    const text = 'id;name;note\r\n1;"Ann ""the"" Great";"two\r\nlines"\r\n2;Bob;\r\n3;"";x\r\n';
    const whole = parseCsv(text, ";");
    expect(whole).toEqual([["id", "name", "note"], ["1", 'Ann "the" Great', "two\r\nlines"], ["2", "Bob", ""], ["3", "", "x"]]);
    for (const size of [1, 2, 3, 5, 7, 11]) expect(chunked(text, ";", size)).toEqual(whole);
  });

  it("detects the delimiter from the first lines", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n4,5,6\n")).toBe(",");
    expect(detectDelimiter("a;b;c\n1;2;3\n4,5;6\n")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(detectDelimiter('name|city\n"x, y"|z\n')).toBe("|");
    expect(detectDelimiter("one column only\nsecond line\n")).toBe(",");
  });

  it("detects byte order marks", () => {
    expect(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ label: "utf-8", bom: 3 });
    expect(detectEncoding(Buffer.from([0xff, 0xfe, 0x61, 0]))).toEqual({ label: "utf-16le", bom: 2 });
    expect(detectEncoding(Buffer.from("a"))).toEqual({ label: "utf-8", bom: 0 });
  });
});

describe("CSV files", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "oc-csv-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("streams a UTF-8 file with a BOM and multi-byte characters split across reads", async () => {
    const rows = Array.from({ length: 20000 }, (_, i) => `${i},"Zoë ${i} — ünïcode, ""quoted""",日本語`);
    const file = join(dir, "big.csv");
    await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`id,name,text\n${rows.join("\n")}\n`)]));
    let n = 0;
    let last: string[] = [];
    for await (const { row } of readCsvRows(file, ",")) {
      if (n++ > 0) last = row;
    }
    expect(n).toBe(20001);
    expect(last).toEqual(["19999", 'Zoë 19999 — ünïcode, "quoted"', "日本語"]);
  });

  it("reads UTF-16 files (Excel's 'Unicode text')", async () => {
    const file = join(dir, "u16.csv");
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a\tb\n1\tü\n", "utf16le")]));
    const rows: string[][] = [];
    for await (const { row } of readCsvRows(file, "\t")) rows.push(row);
    expect(rows).toEqual([["a", "b"], ["1", "ü"]]);
    expect((await sampleCsv(file)).delimiter).toBe("\t");
  });

  it("samples the head of a big file without reading all of it, and estimates the row count", async () => {
    const file = join(dir, "sample.csv");
    const body = Array.from({ length: 100000 }, (_, i) => `${i},name${i},${i % 7}`).join("\n");
    await writeFile(file, `id,name,n\n${body}\n`);
    const s = await sampleCsv(file);
    expect(s.delimiter).toBe(",");
    expect(s.rows[0]).toEqual(["id", "name", "n"]);
    expect(s.rows).toHaveLength(30);
    expect(s.estimatedRows).toBeGreaterThan(80000);
    expect(s.estimatedRows).toBeLessThan(125000);
  });

  it("parses about 50 MB in a few seconds", async () => {
    const file = join(dir, "perf.csv");
    const line = '12345,"Some customer name, Inc.",2024-01-31,19.99,true,"a note with ""quotes"" in it"\n';
    await writeFile(file, line.repeat(600_000)); // ~50 MB
    const t0 = Date.now();
    let n = 0;
    for await (const _ of readCsvRows(file, ",")) n++;
    const ms = Date.now() - t0;
    console.log(`parsed ${n.toLocaleString()} rows (${(line.length * n / 1048576).toFixed(0)} MB) in ${ms} ms`);
    expect(n).toBe(600_000);
    expect(ms).toBeLessThan(8000);
  });
});
