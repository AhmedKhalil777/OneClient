import type { CompletionItem, CompletionProvider } from "@oneclient/editor-kit";
import { invokeCompletionCatalog, listDatabases } from "./api.js";
import { FUNCTIONS, KEYWORDS, OPERATORS, TYPES } from "./highlight.js";

export interface Catalog {
  database: string;
  schemas: string[];
  objects: Array<{ schema: string; name: string; kind: "table" | "view" | "procedure" | "function" }>;
  columns: Array<{ schema: string; object: string; name: string; type: string }>;
}

/** Names that must be bracketed to be valid T-SQL identifiers. */
function quoteIfNeeded(name: string): string {
  return /^[A-Za-z_@#][\w@#$]*$/.test(name) && !KEYWORDS.has(name.toUpperCase()) ? name : `[${name.replace(/]/g, "]]")}]`;
}

function unquote(part: string): string {
  return part.startsWith("[") ? part.slice(1, -1).replace(/]]/g, "]") : part;
}

const IDENT = String.raw`(?:\[[^\]]+\]|[\w#$]+)`;
/** `[a].[b].` / `dbo.` / `c.` right before the word being typed. */
const QUALIFIER = new RegExp(String.raw`((?:${IDENT}\s*\.\s*)+)$`);
/** FROM/JOIN/UPDATE/INTO <name> [AS] <alias> */
const TABLE_REF = new RegExp(
  String.raw`\b(?:FROM|JOIN|UPDATE|INTO|APPLY)\s+(${IDENT}(?:\s*\.\s*${IDENT}){0,2})(?:\s+(?:AS\s+)?(${IDENT}))?`,
  "gi",
);
const NOT_ALIAS = new Set(
  "WHERE ON JOIN INNER LEFT RIGHT FULL CROSS OUTER GROUP ORDER HAVING UNION EXCEPT INTERSECT SET WITH OPTION AS SELECT VALUES OUTPUT PIVOT UNPIVOT GO".split(" "),
);

/** Tables referenced in the script, keyed by alias and by bare name (lower-case) → [db?, schema?, name]. */
export function tableReferences(text: string): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const m of text.matchAll(TABLE_REF)) {
    const parts = m[1]!.split(/\s*\.\s*/).map(unquote);
    const name = parts[parts.length - 1]!;
    refs.set(name.toLowerCase(), parts);
    const alias = m[2] ? unquote(m[2]) : undefined;
    if (alias && !NOT_ALIAS.has(alias.toUpperCase())) refs.set(alias.toLowerCase(), parts);
  }
  return refs;
}

/** The keyword right before the word being typed, to put the likely kind of item first. */
function previousKeyword(textBefore: string): string | undefined {
  return /\b([A-Za-z]+)\s+(?:\S+\s*,\s*)*[\w@#$[\]]*$/.exec(textBefore)?.[1]?.toUpperCase();
}

/**
 * T-SQL IntelliSense for the query window: keywords/functions/types, the
 * current database's schemas, tables, views, procedures and columns, and
 * dotted completion (`dbo.`, `alias.`, `db.schema.`). The catalog per
 * database is loaded once and cached; `invalidate()` after DDL.
 */
export function createSqlCompletionProvider(getDatabase: () => string | undefined) {
  const catalogs = new Map<string, Promise<Catalog | null>>();
  let databases: Promise<string[]> | null = null;

  function catalog(database: string | undefined): Promise<Catalog | null> {
    const key = (database ?? "").toLowerCase();
    let entry = catalogs.get(key);
    if (!entry) {
      entry = invokeCompletionCatalog(database).catch((err: unknown) => {
        console.warn("[completion] catalog failed", err);
        catalogs.delete(key);
        return null;
      });
      catalogs.set(key, entry);
    }
    return entry;
  }

  function columnsOf(cat: Catalog, schema: string | undefined, object: string): CompletionItem[] {
    const lower = object.toLowerCase();
    return cat.columns
      .filter((c) => c.object.toLowerCase() === lower && (!schema || c.schema.toLowerCase() === schema.toLowerCase()))
      .map((c, i) => ({
        label: c.name,
        kind: "column" as const,
        detail: c.type,
        documentation: `${c.schema}.${c.object}.${c.name}`,
        insertText: quoteIfNeeded(c.name),
        sortText: String(i).padStart(5, "0"), // table column order
      }));
  }

  function objectItem(o: Catalog["objects"][number], qualify: boolean): CompletionItem {
    const name = quoteIfNeeded(o.name);
    return {
      label: o.name,
      kind: o.kind === "function" ? "function" : o.kind,
      detail: `${o.schema} · ${o.kind}`,
      insertText: qualify ? `${quoteIfNeeded(o.schema)}.${name}` : name,
    };
  }

  const provider: CompletionProvider = {
    triggerCharacters: ["."],

    async provideCompletions(ctx) {
      const before = ctx.text.slice(0, ctx.wordStart);
      const currentDb = getDatabase();
      const qualifier = QUALIFIER.exec(before)?.[1];

      // ---- dotted: alias./table./schema./db./db.schema./db.schema.table. ----
      if (qualifier) {
        const parts = qualifier.split(/\s*\.\s*/).filter(Boolean).map(unquote);
        // Leave out the reference being typed: in "FROM dbo.|" the half-typed "dbo." isn't a table called dbo.
        const qualifierStart = ctx.wordStart - qualifier.length;
        const refs = tableReferences(ctx.text.slice(0, qualifierStart) + ctx.text.slice(ctx.offset));
        const cat = await catalog(currentDb);
        if (!cat) return [];
        const dbNames = await (databases ??= listDatabases().catch(() => []));
        const isDb = (n: string) => dbNames.some((d) => d.toLowerCase() === n.toLowerCase());
        const isSchema = (c: Catalog, n: string) => c.schemas.some((s) => s.toLowerCase() === n.toLowerCase());

        if (parts.length === 1) {
          const [q] = parts as [string];
          const ref = refs.get(q.toLowerCase());
          if (ref) {
            // alias or table name used in FROM/JOIN → its columns (from the right database)
            const refCat = ref.length === 3 ? await catalog(ref[0]) : cat;
            return refCat ? columnsOf(refCat, ref.length >= 2 ? ref[ref.length - 2] : undefined, ref[ref.length - 1]!) : [];
          }
          if (isSchema(cat, q)) return cat.objects.filter((o) => o.schema.toLowerCase() === q.toLowerCase()).map((o) => objectItem(o, false));
          if (cat.objects.some((o) => o.name.toLowerCase() === q.toLowerCase())) return columnsOf(cat, undefined, q);
          if (isDb(q)) {
            const other = await catalog(q);
            return other ? other.schemas.map((s) => ({ label: s, kind: "schema" as const, insertText: quoteIfNeeded(s) })) : [];
          }
          return [];
        }
        if (parts.length === 2) {
          const [a, b] = parts as [string, string];
          if (isDb(a)) {
            const other = await catalog(a);
            return other ? other.objects.filter((o) => o.schema.toLowerCase() === b.toLowerCase()).map((o) => objectItem(o, false)) : [];
          }
          return columnsOf(cat, a, b);
        }
        const [db, schema, table] = parts.slice(-3) as [string, string, string];
        const other = await catalog(db);
        return other ? columnsOf(other, schema, table) : [];
      }

      // ---- plain word: keywords, functions, types, objects, columns in scope, variables ----
      const items: CompletionItem[] = [];
      const prev = previousKeyword(before);
      const wantsTable = prev !== undefined && ["FROM", "JOIN", "UPDATE", "INTO", "TABLE", "APPLY"].includes(prev);
      const wantsProc = prev === "EXEC" || prev === "EXECUTE";
      const wantsDb = prev === "USE";

      // Variables: anything @declared in the script (ctx.prefix may already start with @).
      for (const m of ctx.text.matchAll(/@[A-Za-z_][\w@#$]*/g)) {
        if (m.index !== ctx.wordStart) items.push({ label: m[0], kind: "variable", sortText: `0${m[0]}` });
      }
      if (ctx.prefix.startsWith("@")) return items;

      const cat = await catalog(currentDb);
      const dbNames = await (databases ??= listDatabases().catch(() => []));

      if (cat) {
        for (const o of cat.objects) {
          if (wantsProc && o.kind !== "procedure") continue;
          // In a FROM/JOIN/EXEC position insert "schema.name" — unambiguous across schemas.
          const item = objectItem(o, wantsProc || (wantsTable && (o.kind === "table" || o.kind === "view")));
          const priority = (wantsTable && (o.kind === "table" || o.kind === "view")) || (wantsProc && o.kind === "procedure") ? "0" : "3";
          items.push({ ...item, sortText: `${priority}${o.name}` });
        }
        for (const s of cat.schemas) items.push({ label: s, kind: "schema", insertText: quoteIfNeeded(s), sortText: `${wantsTable ? "1" : "4"}${s}` });
        // Columns of the tables this script references (no alias needed).
        if (!wantsTable && !wantsProc && !wantsDb) {
          for (const parts of new Set(tableReferences(ctx.text).values())) {
            const refCat = parts.length === 3 ? await catalog(parts[0]) : cat;
            if (!refCat) continue;
            for (const col of columnsOf(refCat, parts.length >= 2 ? parts[parts.length - 2] : undefined, parts[parts.length - 1]!)) {
              items.push({ ...col, sortText: `1${col.label}` });
            }
          }
        }
      }
      for (const d of dbNames) items.push({ label: d, kind: "database", insertText: quoteIfNeeded(d), sortText: `${wantsDb ? "0" : "5"}${d}` });

      if (!wantsDb) {
        for (const k of KEYWORDS) items.push({ label: k, kind: "keyword", sortText: `2${k}` });
        for (const k of OPERATORS) items.push({ label: k, kind: "keyword", sortText: `2${k}` });
        for (const f of FUNCTIONS) items.push({ label: f, kind: "function", insertText: `${f}($0)`, detail: "function", sortText: `2${f}` });
        for (const t of TYPES) items.push({ label: t.toLowerCase(), kind: "type", sortText: `2${t}` });
      }
      return items;
    },
  };

  return {
    provider,
    /** Drop cached catalogs (call after running DDL so new tables/columns show up). */
    invalidate() {
      catalogs.clear();
      databases = null;
    },
  };
}
