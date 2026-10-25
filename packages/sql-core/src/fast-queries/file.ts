/**
 * The `*.query.sql` file format — a fast query on disk is a plain SQL script (opens in any editor, diffs nicely) whose
 * leading comment lines carry its settings:
 *
 *   -- name: Blocking sessions
 *   -- database: Shop                      (optional: the query is listed under, and runs in, this database)
 *   -- description: Who blocks whom right now   (optional: shown as the tree item's tooltip)
 *   SELECT …
 *
 * Only `-- key: value` lines at the very top count; the first other line starts the script. Without a name, the
 * file name is used.
 */

export const FAST_QUERY_EXT = ".query.sql";

export interface FastQueryDoc {
  name: string;
  database?: string | undefined;
  description?: string | undefined;
  sql: string;
}

const HEADER = /^--\s*(name|database|description)\s*:\s*(.*?)\s*$/i;

export function nameFromFile(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return base.toLowerCase().endsWith(FAST_QUERY_EXT) ? base.slice(0, -FAST_QUERY_EXT.length) : base;
}

export function readFastQuery(text: string, file: string): FastQueryDoc {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const meta: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]!);
    if (!m) break;
    meta[m[1]!.toLowerCase()] = m[2]!;
  }
  const sql = lines.slice(i).join("\n").replace(/^\s*\n/, "").trimEnd();
  return {
    name: meta.name || nameFromFile(file),
    ...(meta.database ? { database: meta.database } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    sql,
  };
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function writeFastQuery(doc: FastQueryDoc): string {
  const header = [`-- name: ${oneLine(doc.name)}`];
  if (doc.database) header.push(`-- database: ${oneLine(doc.database)}`);
  if (doc.description) header.push(`-- description: ${oneLine(doc.description)}`);
  return `${header.join("\n")}\n\n${doc.sql.trim()}\n`;
}
