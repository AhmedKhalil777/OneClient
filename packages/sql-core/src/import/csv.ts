import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

/**
 * CSV reading that never holds the file in memory: an incremental parser (RFC 4180: quotes, "" escapes, line breaks inside
 * quotes, CRLF / LF / CR) fed with decoded chunks, plus encoding and delimiter detection for the import dialog.
 */

export interface CsvParser {
  /** Feed the next chunk of text; returns the rows completed by it. A row split across chunks is held back. */
  push(text: string): string[][];
  /** The end of the file: returns the last row (a file needn't end with a line break). */
  end(): string[][];
}

const QUOTE = 34; // "
const LF = 10;
const CR = 13;

export function createCsvParser(delimiter: string): CsvParser {
  const D = delimiter.charCodeAt(0);
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  /** Saw a quote inside a quoted field: the next char says whether it was an escaped "" or the closing quote. */
  let quoteSeen = false;
  let afterCR = false;
  /** The current field began with a quote (so an empty `""` is an empty value, not a blank line). */
  let quoted = false;

  const endRow = (out: string[][]) => {
    row.push(field);
    // A line with nothing on it (one empty, unquoted field) is skipped.
    if (row.length > 1 || row[0] !== "" || quoted) out.push(row);
    row = [];
    field = "";
    quoted = false;
  };

  return {
    push(text) {
      const out: string[][] = [];
      let segment = 0; // start of the run of plain characters not yet appended to `field`
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (quoteSeen) {
          quoteSeen = false;
          if (c === QUOTE) {
            field += '"'; // "" inside quotes is one quote character
            segment = i + 1;
            continue;
          }
          inQuotes = false; // that quote closed the field; this character is outside the quotes
          segment = i;
        }
        if (inQuotes) {
          if (c === QUOTE) {
            field += text.slice(segment, i);
            segment = i + 1;
            quoteSeen = true;
          }
          continue;
        }
        if (afterCR) {
          afterCR = false;
          if (c === LF) {
            segment = i + 1;
            continue;
          }
        }
        if (c === D) {
          field += text.slice(segment, i);
          row.push(field);
          field = "";
          quoted = false;
          segment = i + 1;
        } else if (c === LF || c === CR) {
          field += text.slice(segment, i);
          endRow(out);
          segment = i + 1;
          afterCR = c === CR;
        } else if (c === QUOTE && field === "" && i === segment) {
          inQuotes = true;
          quoted = true;
          segment = i + 1;
        }
      }
      field += text.slice(segment);
      return out;
    },
    end() {
      const out: string[][] = [];
      if (field !== "" || row.length > 0 || quoted) endRow(out);
      return out;
    },
  };
}

/** Parses a whole string (for the preview and tests). */
export function parseCsv(text: string, delimiter: string): string[][] {
  const p = createCsvParser(delimiter);
  return [...p.push(text), ...p.end()];
}

// ---- encoding & delimiter ----------------------------------------------------------------------------------------

export interface Encoding {
  label: "utf-8" | "utf-16le" | "utf-16be";
  /** Bytes of the byte order mark to skip. */
  bom: number;
}

export function detectEncoding(head: Buffer): Encoding {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { label: "utf-8", bom: 3 };
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return { label: "utf-16le", bom: 2 };
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return { label: "utf-16be", bom: 2 };
  return { label: "utf-8", bom: 0 };
}

const CANDIDATES = [",", ";", "\t", "|"];

/** The delimiter that splits the first lines into the same number (> 1) of fields most consistently. */
export function detectDelimiter(sample: string): string {
  let best = ",";
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const rows = parseCsv(sample, d).slice(0, 20);
    if (!rows.length) continue;
    const counts = rows.map((r) => r.length);
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)]!;
    if (mode < 2) continue;
    const consistent = counts.filter((n) => n === mode).length / counts.length;
    const score = consistent * mode;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export interface CsvSample {
  encoding: Encoding;
  delimiter: string;
  rows: string[][];
  /** File size in bytes. */
  size: number;
  /** Rough row count from the sample's average row size. */
  estimatedRows: number;
}

/** Reads the head of the file (not all of it) for the preview. `delimiter` forces one; otherwise it is detected. */
export async function sampleCsv(path: string, delimiter?: string, maxRows = 30): Promise<CsvSample> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.min(size, 256 * 1024));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    const encoding = detectEncoding(head);
    const text = new TextDecoder(encoding.label).decode(head.subarray(encoding.bom));
    const d = delimiter || detectDelimiter(text);
    const parser = createCsvParser(d);
    const rows = parser.push(text);
    const sampled = rows.slice(0, maxRows);
    // The sample ends mid-row unless it is the whole file.
    const all = bytesRead >= size ? [...rows, ...parser.end()].slice(0, maxRows) : sampled;
    const avg = rows.length ? (bytesRead - encoding.bom) / rows.length : 0;
    const estimatedRows = bytesRead >= size ? rows.length + parser.end().length : avg ? Math.round((size - encoding.bom) / avg) : 0;
    return { encoding, delimiter: d, rows: all, size, estimatedRows };
  } finally {
    await fh.close();
  }
}

/** Streams the rows of a file, with the bytes read so far (for progress). Stops early when the consumer breaks out. */
export async function* readCsvRows(path: string, delimiter: string, encoding?: Encoding): AsyncGenerator<{ row: string[]; bytes: number }> {
  const enc = encoding ?? (await (async () => {
    const fh = await open(path, "r");
    try {
      const b = Buffer.alloc(4);
      const { bytesRead } = await fh.read(b, 0, 4, 0);
      return detectEncoding(b.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
  })());
  const decoder = new TextDecoder(enc.label);
  const parser = createCsvParser(delimiter);
  const stream = createReadStream(path, { start: enc.bom, highWaterMark: 1 << 20 });
  let bytes = enc.bom;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      for (const row of parser.push(decoder.decode(chunk, { stream: true }))) yield { row, bytes };
    }
    for (const row of [...parser.push(decoder.decode()), ...parser.end()]) yield { row, bytes };
  } finally {
    stream.destroy();
  }
}
