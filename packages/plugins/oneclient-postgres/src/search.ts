import type { SearchResult } from "@oneclient/plugin-api";
import { listDatabases } from "./metadata.js";
import { poolFor, requireSession } from "./sessions.js";

const MAX_DATABASES = 16;
const DATABASES_TTL_MS = 60_000;
const databases = new Map<string, { at: number; names: string[] }>();

const KINDS: Record<string, { label: string; icon: string; command: string }> = {
  r: { label: "Table", icon: "$(table)", command: "postgres.selectTop" },
  p: { label: "Table", icon: "$(table)", command: "postgres.selectTop" },
  f: { label: "Foreign table", icon: "$(table)", command: "postgres.selectTop" },
  v: { label: "View", icon: "$(view)", command: "postgres.selectTop" },
  m: { label: "Materialized view", icon: "$(view)", command: "postgres.selectTop" },
  fn: { label: "Function", icon: "$(function)", command: "postgres.scriptModify" },
  pr: { label: "Procedure", icon: "$(procedure)", command: "postgres.scriptModify" },
};

/** `%`, `_` are LIKE wildcards; a search for "my_table" means the underscore literally. */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function searchableDatabases(connectionId: string): Promise<string[]> {
  const cached = databases.get(connectionId);
  if (cached && Date.now() - cached.at < DATABASES_TTL_MS) return cached.names;
  const names = (await listDatabases(poolFor(connectionId)))
    .filter((d) => d.allowConn && !d.isTemplate)
    .map((d) => d.name)
    .slice(0, MAX_DATABASES);
  databases.set(connectionId, { at: Date.now(), names });
  return names;
}

/**
 * Global search provider: tables, views, functions and procedures whose name matches, across the server's
 * databases. A table or view opens "Select Top 1000"; a function or procedure opens its CREATE OR REPLACE script.
 */
export async function searchObjects(connectionId: string, query: string, limit: number): Promise<SearchResult[]> {
  requireSession(connectionId);
  const text = query.trim();
  const contains = `%${likeEscape(text)}%`;
  const dbs = await searchableDatabases(connectionId);

  const perDb = await Promise.all(
    dbs.map(async (database) => {
      try {
        const r = await poolFor(connectionId, database).query<{ schema: string; name: string; kind: string; args: string | null; sig: string | null }>(
          `SELECT * FROM (
             SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, NULL AS args, NULL AS sig
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r','p','f','v','m') AND NOT c.relispartition
                AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
                AND (c.relname ILIKE $1 OR n.nspname || '.' || c.relname ILIKE $1)
             UNION ALL
             SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'pr' ELSE 'fn' END, pg_get_function_identity_arguments(p.oid), oidvectortypes(p.proargtypes)
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
              WHERE p.prokind IN ('f','p') AND d.objid IS NULL
                AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
                AND (p.proname ILIKE $1 OR n.nspname || '.' || p.proname ILIKE $1)
           ) x ORDER BY lower(name) = lower($2) DESC, name ILIKE $3 DESC, length(name), name LIMIT $4`,
          [contains, text, `${likeEscape(text)}%`, Math.max(limit, 10)],
        );
        return r.rows.map((row) => ({ database, ...row }));
      } catch {
        return []; // a database we can't read just contributes nothing
      }
    }),
  );

  const t = text.toLowerCase();
  const rank = (name: string) => (name.toLowerCase() === t ? 0 : name.toLowerCase().startsWith(t) ? 1 : 2);
  return perDb
    .flat()
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit)
    .flatMap((o): SearchResult[] => {
      const kind = KINDS[o.kind];
      if (!kind) return [];
      const objKind = o.kind === "fn" ? "functions" : o.kind === "pr" ? "procedures" : o.kind === "v" ? "views" : o.kind === "m" ? "matviews" : "tables";
      return [
        {
          label: `${o.schema}.${o.name}${o.args !== null ? `(${o.args})` : ""}`,
          description: `${kind.label} · ${o.database}`,
          icon: kind.icon,
          command: { id: kind.command, args: { database: o.database, schema: o.schema, name: o.name, kind: objKind, ...(o.sig !== null ? { sig: o.sig } : {}) } },
        },
      ];
    });
}
