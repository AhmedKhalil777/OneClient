import type { SearchResult } from "@oneclient/plugin-api";
import { SYSTEM_DATABASES } from "./config.js";
import { poolFor, requireSession } from "./sessions.js";

const SYSTEM_LIST = SYSTEM_DATABASES.map((d) => `'${d}'`).join(",");

/** `%`, `_` are LIKE wildcards; a search for "my_table" means the underscore literally. */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Global search provider: tables, views, procedures and functions whose name matches, across every database on the
 * server, in one query. A table or view opens "Select Top 1000"; a routine opens its CREATE script.
 */
export async function searchObjects(connectionId: string, query: string, limit: number): Promise<SearchResult[]> {
  requireSession(connectionId);
  const text = query.trim();
  if (!text) return [];
  const contains = `%${likeEscape(text)}%`;
  const [rows] = (await poolFor(connectionId).query(
    `SELECT * FROM (
       SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, IF(TABLE_TYPE = 'VIEW', 'view', 'table') AS kind
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA NOT IN (${SYSTEM_LIST}) AND (TABLE_NAME LIKE ? OR CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) LIKE ?)
       UNION ALL
       SELECT ROUTINE_SCHEMA, ROUTINE_NAME, LOWER(ROUTINE_TYPE)
         FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA NOT IN (${SYSTEM_LIST}) AND (ROUTINE_NAME LIKE ? OR CONCAT(ROUTINE_SCHEMA, '.', ROUTINE_NAME) LIKE ?)
     ) x ORDER BY LOWER(name) = LOWER(?) DESC, name LIKE ? DESC, LENGTH(name), name LIMIT ?`,
    [contains, contains, contains, contains, text, `${likeEscape(text)}%`, Math.max(limit, 10)],
  )) as unknown as [Array<{ db: string; name: string; kind: "table" | "view" | "procedure" | "function" }>];

  return rows.slice(0, limit).map((o): SearchResult => {
    const routine = o.kind === "procedure" || o.kind === "function";
    return {
      label: `${o.db}.${o.name}`,
      description: `${o.kind === "table" ? "Table" : o.kind === "view" ? "View" : o.kind === "procedure" ? "Procedure" : "Function"}`,
      icon: o.kind === "table" ? "$(table)" : o.kind === "view" ? "$(view)" : o.kind === "procedure" ? "$(procedure)" : "$(function)",
      command: { id: routine ? "mysql.scriptModify" : "mysql.selectTop", args: { database: o.db, schema: o.db, name: o.name, kind: o.kind === "table" ? "tables" : o.kind === "view" ? "views" : o.kind === "procedure" ? "procedures" : "functions" } },
    };
  });
}
