import type { CompletionItem, CompletionProvider } from "@oneclient/editor-kit";
import { invokeCompletionCatalog } from "./api.js";
import { quoteIdent } from "../src/config.js";
import { FUNCTIONS, KEYWORDS, OPERATORS, TYPES } from "./highlight.js";

export interface Catalog {
  database: string;
  schemas: string[];
  searchPath: string[];
  objects: Array<{ schema: string; name: string; kind: "table" | "view" | "procedure" | "function" }>;
  columns: Array<{ schema: string; object: string; name: string; type: string }>;
}

/** Lower-case names that aren't reserved words go bare; anything else needs "double quotes" (same rule as the backend). */
export const quoteIfNeeded = quoteIdent;

/** How PostgreSQL resolves a name as written: "Quoted" keeps its case, bare folds to lower case. */
export function unquote(part: string): string {
  return part.startsWith('"') ? part.slice(1, -1).replace(/""/g, '"') : part.toLowerCase();
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
/** `schema.` / `alias.` / `schema.table.` right before the word being typed. */
const QUALIFIER = new RegExp(String.raw`((?:${IDENT}\s*\.\s*)+)$`);
/** FROM/JOIN/UPDATE/INTO <name> [AS] <alias> */
const TABLE_REF = new RegExp(String.raw`\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+(?:ONLY\s+)?(${IDENT}(?:\s*\.\s*${IDENT})?)(?:\s+(?:AS\s+)?(${IDENT}))?`, "gi");
const NOT_ALIAS = new Set(
  "WHERE ON JOIN INNER LEFT RIGHT FULL CROSS OUTER NATURAL LATERAL GROUP ORDER HAVING UNION EXCEPT INTERSECT SET WITH AS SELECT VALUES RETURNING LIMIT OFFSET USING WINDOW FETCH FOR DEFAULT".split(" "),
);

/** Tables referenced in the script, keyed by alias and by bare name → [schema?, name]. */
export function tableReferences(text: string): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const m of text.matchAll(TABLE_REF)) {
    const parts = m[1]!.split(/\s*\.\s*/).map(unquote);
    const name = parts[parts.length - 1]!;
    refs.set(name, parts);
    const aliasRaw = m[2];
    if (aliasRaw && !NOT_ALIAS.has(aliasRaw.toUpperCase())) refs.set(unquote(aliasRaw), parts);
  }
  return refs;
}

function previousKeyword(textBefore: string): string | undefined {
  return /\b([A-Za-z]+)\s+(?:\S+\s*,\s*)*[\w$"]*$/.exec(textBefore)?.[1]?.toUpperCase();
}

/**
 * PostgreSQL IntelliSense for the query window: keywords / functions / types, the database's schemas, tables,
 * views, functions, procedures and columns, and dotted completion (`schema.`, `alias.`, `table.`). Unqualified
 * names resolve through the session's search_path. The catalog per database is cached; `invalidate()` after DDL.
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

  /** Columns of [schema?, name]; without a schema, the first search_path schema that has it wins. */
  function columnsOf(cat: Catalog, ref: string[]): CompletionItem[] {
    const name = ref[ref.length - 1]!;
    let schema = ref.length >= 2 ? ref[ref.length - 2] : undefined;
    if (!schema) schema = cat.searchPath.find((s) => cat.objects.some((o) => o.schema === s && o.name === name)) ?? cat.objects.find((o) => o.name === name)?.schema;
    return cat.columns
      .filter((c) => c.object === name && c.schema === schema)
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
    // Objects outside the search_path always need their schema.
    const needsSchema = qualify || !cat.searchPath.includes(o.schema);
    const text = needsSchema ? `${quoteIfNeeded(o.schema)}.${name}` : name;
    return { label: o.name, kind: o.kind === "procedure" ? "procedure" : o.kind, detail: `${o.schema} · ${o.kind}`, insertText: routine ? `${text}($0)` : text };
  }

  const provider: CompletionProvider = {
    triggerCharacters: ["."],

    async provideCompletions(ctx) {
      const before = ctx.text.slice(0, ctx.wordStart);
      const qualifier = QUALIFIER.exec(before)?.[1];
      const cat = await catalog(getDatabase());

      // ---- dotted: alias. / table. / schema. / schema.table. ----
      if (qualifier) {
        if (!cat) return [];
        // "123." is a number, "::type." a cast — neither qualifies anything.
        if (/\d\s*\.\s*$/.test(before) && !/[A-Za-z_"]/.test(qualifier)) return [];
        const parts = qualifier.split(/\s*\.\s*/).filter(Boolean).map(unquote);
        const qualifierStart = ctx.wordStart - qualifier.length;
        const refs = tableReferences(ctx.text.slice(0, qualifierStart) + ctx.text.slice(ctx.offset));
        if (parts.length === 1) {
          const [q] = parts as [string];
          const ref = refs.get(q);
          if (ref) return columnsOf(cat, ref);
          if (cat.schemas.includes(q)) return cat.objects.filter((o) => o.schema === q).map((o) => objectItem(o, cat, false));
          if (cat.objects.some((o) => o.name === q)) return columnsOf(cat, [q]);
          return [];
        }
        return columnsOf(cat, parts.slice(-2));
      }

      // ---- plain word ----
      const items: CompletionItem[] = [];
      const prev = previousKeyword(before);
      const wantsTable = prev !== undefined && ["FROM", "JOIN", "UPDATE", "INTO", "TABLE", "ONLY"].includes(prev);
      const wantsProc = prev === "CALL";
      // After "::" a type is coming.
      const wantsType = /::\s*$/.test(before);

      if (cat && !wantsType) {
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
      for (const t of TYPES) items.push({ label: t.toLowerCase(), kind: "type", sortText: `${wantsType ? "0" : "2"}${t}` });
      if (!wantsType) {
        for (const k of KEYWORDS) items.push({ label: k, kind: "keyword", sortText: `2${k}` });
        for (const k of OPERATORS) items.push({ label: k, kind: "keyword", sortText: `2${k}` });
        for (const f of FUNCTIONS) items.push({ label: f.toLowerCase(), kind: "function", insertText: `${f.toLowerCase()}($0)`, detail: "function", sortText: `2${f}` });
      }
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
