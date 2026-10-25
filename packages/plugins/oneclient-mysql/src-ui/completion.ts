import type { CompletionItem, CompletionProvider } from "@oneclient/editor-kit";
import { invokeCompletionCatalog } from "./api.js";
import { FUNCTIONS, KEYWORDS, OPERATORS, TYPES } from "./highlight.js";

export interface Catalog {
  database: string;
  /** Every database: `db.` completes that database's objects. */
  schemas: string[];
  /** The window's current database — unqualified names resolve against it. */
  searchPath: string[];
  objects: Array<{ schema: string; name: string; kind: "table" | "view" | "procedure" | "function" }>;
  columns: Array<{ schema: string; object: string; name: string; type: string }>;
}

/** Names that are plain words (and not keywords) go bare; anything else needs `backticks`. */
export function quoteIfNeeded(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && !KEYWORDS.has(name.toUpperCase()) && !TYPES.has(name.toUpperCase()) ? name : `\`${name.replace(/`/g, "``")}\``;
}

/** A `quoted` name loses its backticks; a bare one is kept as written (table names are case-sensitive on most servers). */
export function unquote(part: string): string {
  return part.startsWith("`") ? part.slice(1, -1).replace(/``/g, "`") : part;
}

const IDENT = String.raw`(?:` + "`" + String.raw`(?:[^` + "`" + String.raw`]|` + "``" + String.raw`)+` + "`" + String.raw`|[A-Za-z_][\w$]*)`;
/** `db.` / `alias.` / `db.table.` right before the word being typed. */
const QUALIFIER = new RegExp(String.raw`((?:${IDENT}\s*\.\s*)+)$`);
/** FROM/JOIN/UPDATE/INTO <name> [AS] <alias> */
const TABLE_REF = new RegExp(String.raw`\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+(${IDENT}(?:\s*\.\s*${IDENT})?)(?:\s+(?:AS\s+)?(${IDENT}))?`, "gi");
const NOT_ALIAS = new Set(
  "WHERE ON JOIN INNER LEFT RIGHT CROSS OUTER NATURAL STRAIGHT_JOIN GROUP ORDER HAVING UNION EXCEPT INTERSECT SET WITH AS SELECT VALUES LIMIT OFFSET USING WINDOW FOR USE FORCE IGNORE PARTITION".split(" "),
);

/** Tables referenced in the script, keyed by alias and by bare name → [db?, name]. */
export function tableReferences(text: string): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const m of text.matchAll(TABLE_REF)) {
    const parts = m[1]!.split(/\s*\.\s*/).map(unquote);
    refs.set(parts[parts.length - 1]!, parts);
    const aliasRaw = m[2];
    if (aliasRaw && !NOT_ALIAS.has(aliasRaw.toUpperCase())) refs.set(unquote(aliasRaw), parts);
  }
  return refs;
}

function previousKeyword(textBefore: string): string | undefined {
  return /\b([A-Za-z]+)\s+(?:\S+\s*,\s*)*[\w$`]*$/.exec(textBefore)?.[1]?.toUpperCase();
}

/**
 * MySQL IntelliSense for the query window: keywords / functions / types, the window's database objects and columns, and
 * dotted completion (`db.`, `alias.`, `table.`). The catalog per database is cached; `invalidate()` after DDL.
 */
export function createSqlCompletionProvider(getDatabase: () => string | undefined) {
  const catalogs = new Map<string, Promise<Catalog | null>>();

  function catalog(database: string | undefined): Promise<Catalog | null> {
    const key = database ?? "";
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

  /** Columns of [db?, name]; only the window's own database is loaded, so another database's tables have none. */
  function columnsOf(cat: Catalog, ref: string[]): CompletionItem[] {
    const name = ref[ref.length - 1]!;
    const db = ref.length >= 2 ? ref[ref.length - 2] : cat.database;
    if (db !== cat.database) return [];
    return cat.columns
      .filter((c) => c.object === name)
      .map((c, i) => ({
        label: c.name,
        kind: "column" as const,
        detail: c.type,
        documentation: `${c.schema}.${c.object}.${c.name}`,
        insertText: quoteIfNeeded(c.name),
        sortText: String(i).padStart(5, "0"),
      }));
  }

  function objectItem(o: Catalog["objects"][number], cat: Catalog, qualify: boolean): CompletionItem {
    const name = quoteIfNeeded(o.name);
    const routine = o.kind === "function" || o.kind === "procedure";
    const text = qualify || !cat.searchPath.includes(o.schema) ? `${quoteIfNeeded(o.schema)}.${name}` : name;
    return { label: o.name, kind: o.kind === "procedure" ? "procedure" : o.kind, detail: `${o.schema} · ${o.kind}`, insertText: routine ? `${text}($0)` : text };
  }

  const provider: CompletionProvider = {
    triggerCharacters: ["."],

    async provideCompletions(ctx) {
      const before = ctx.text.slice(0, ctx.wordStart);
      const qualifier = QUALIFIER.exec(before)?.[1];
      const cat = await catalog(getDatabase());

      // ---- dotted: alias. / table. / db. / db.table. ----
      if (qualifier) {
        if (!cat) return [];
        if (/\d\s*\.\s*$/.test(before) && !/[A-Za-z_`]/.test(qualifier)) return []; // "123." is a number
        const parts = qualifier.split(/\s*\.\s*/).filter(Boolean).map(unquote);
        const qualifierStart = ctx.wordStart - qualifier.length;
        const refs = tableReferences(ctx.text.slice(0, qualifierStart) + ctx.text.slice(ctx.offset));
        if (parts.length === 1) {
          const [q] = parts as [string];
          const ref = refs.get(q);
          if (ref) return columnsOf(cat, ref);
          if (q === cat.database) return cat.objects.map((o) => objectItem(o, cat, false));
          if (cat.objects.some((o) => o.name === q)) return columnsOf(cat, [q]);
          return [];
        }
        return columnsOf(cat, parts.slice(-2));
      }

      // ---- plain word ----
      const items: CompletionItem[] = [];
      const prev = previousKeyword(before);
      const wantsTable = prev !== undefined && ["FROM", "JOIN", "UPDATE", "INTO", "TABLE"].includes(prev);
      const wantsProc = prev === "CALL";

      if (cat) {
        for (const o of cat.objects) {
          if (wantsProc && o.kind !== "procedure") continue;
          if (wantsTable && (o.kind === "function" || o.kind === "procedure")) continue;
          const priority = (wantsTable && (o.kind === "table" || o.kind === "view")) || (wantsProc && o.kind === "procedure") ? "0" : "3";
          items.push({ ...objectItem(o, cat, false), sortText: `${priority}${o.name}` });
        }
        for (const s of cat.schemas) items.push({ label: s, kind: "schema", insertText: quoteIfNeeded(s), sortText: `${wantsTable ? "1" : "4"}${s}` });
        if (!wantsTable && !wantsProc) {
          for (const parts of new Set(tableReferences(ctx.text).values())) {
            for (const col of columnsOf(cat, parts)) items.push({ ...col, sortText: `1${col.label}` });
          }
        }
      }
      for (const t of TYPES) items.push({ label: t.toLowerCase(), kind: "type", sortText: `2${t}` });
      for (const k of KEYWORDS) items.push({ label: k, kind: "keyword", sortText: `2${k}` });
      for (const k of OPERATORS) items.push({ label: k, kind: "keyword", sortText: `2${k}` });
      for (const f of FUNCTIONS) items.push({ label: f.toLowerCase(), kind: "function", insertText: `${f.toLowerCase()}($0)`, detail: "function", sortText: `2${f}` });
      return items;
    },
  };

  return {
    provider,
    /** Drop cached catalogs (call after running DDL so new tables / columns show up). */
    invalidate() {
      catalogs.clear();
    },
  };
}
