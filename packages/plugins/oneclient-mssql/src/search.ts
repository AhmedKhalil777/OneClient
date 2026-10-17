import type { SearchResult } from "@oneclient/plugin-api";
import { quoteIdent } from "./config.js";
import { listDatabases } from "./metadata.js";
import { requireSession } from "./sessions.js";

const MAX_DATABASES = 24;
const DATABASES_TTL_MS = 60_000;
const databases = new Map<string, { at: number; names: string[] }>();

const KINDS: Record<string, { label: string; icon: string; command: "mssql.selectTop" | "mssql.scriptModify" }> = {
  U: { label: "Table", icon: "$(table)", command: "mssql.selectTop" },
  V: { label: "View", icon: "$(table)", command: "mssql.selectTop" },
  P: { label: "Procedure", icon: "$(procedure)", command: "mssql.scriptModify" },
  FN: { label: "Function", icon: "$(function)", command: "mssql.scriptModify" },
  IF: { label: "Function", icon: "$(function)", command: "mssql.scriptModify" },
  TF: { label: "Function", icon: "$(function)", command: "mssql.scriptModify" },
};

/** `%`, `_` and `[` are LIKE wildcards; a user searching for "my_table" means the underscore literally. `!` is the escape character (a backslash is mangled on its way to the server). */
const likeEscape = (s: string): string => s.replace(/[!%_[]/g, (c) => `!${c}`);

async function userDatabases(connectionId: string): Promise<string[]> {
  const cached = databases.get(connectionId);
  if (cached && Date.now() - cached.at < DATABASES_TTL_MS) return cached.names;
  const { pool } = requireSession(connectionId);
  const names = (await listDatabases(pool)).filter((d) => d.state_desc === "ONLINE" && d.database_id > 4).map((d) => d.name).slice(0, MAX_DATABASES);
  databases.set(connectionId, { at: Date.now(), names });
  return names;
}

export const dropSearchCache = (): void => databases.clear();

/**
 * Global search provider: tables, views, stored procedures and functions whose name matches, across the user
 * databases of the server. Choosing a table or view runs "Select Top 1000" in a query window; a procedure or
 * function opens its definition (CREATE OR ALTER script) — the same things the Object Explorer's menu does.
 */
export async function searchObjects(connectionId: string, query: string, limit: number): Promise<SearchResult[]> {
  const { pool } = requireSession(connectionId);
  const text = query.trim();
  const contains = `%${likeEscape(text)}%`;
  const prefix = `${likeEscape(text)}%`;
  const dbs = await userDatabases(connectionId);

  const perDb = await Promise.all(
    dbs.map(async (database) => {
      try {
        const db = quoteIdent(database);
        const r = await pool
          .request()
          .input("contains", contains)
          .input("prefix", prefix)
          .input("exact", text)
          .input("n", Math.max(limit, 10))
          .query<{ schema: string; name: string; type: string }>(
            `SELECT TOP (@n) s.name AS [schema], o.name, RTRIM(o.type) AS type
               FROM ${db}.sys.objects o JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
              WHERE o.is_ms_shipped = 0 AND o.type IN ('U','V','P','FN','IF','TF')
                AND (o.name LIKE @contains ESCAPE '!' OR (s.name + '.' + o.name) LIKE @contains ESCAPE '!')
              ORDER BY CASE WHEN o.name = @exact THEN 0 WHEN o.name LIKE @prefix ESCAPE '!' THEN 1 ELSE 2 END, LEN(o.name), o.name`,
          );
        return r.recordset.map((row) => ({ database, ...row }));
      } catch {
        return []; // a database we can't read (offline, no permission) just contributes nothing
      }
    }),
  );

  const rank = (name: string) => (name.toLowerCase() === text.toLowerCase() ? 0 : name.toLowerCase().startsWith(text.toLowerCase()) ? 1 : 2);
  return perDb
    .flat()
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit)
    .flatMap((o): SearchResult[] => {
      const kind = KINDS[o.type];
      if (!kind) return [];
      return [
        {
          label: `${o.schema}.${o.name}`,
          description: `${kind.label} · ${o.database}`,
          icon: kind.icon,
          command: { id: kind.command, args: { database: o.database, schema: o.schema, name: o.name } },
        },
      ];
    });
}
