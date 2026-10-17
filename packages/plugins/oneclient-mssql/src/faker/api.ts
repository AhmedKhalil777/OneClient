import type { TreeNode } from "@oneclient/plugin-api";
import { describeConnection } from "../config.js";
import { describeError } from "../errors.js";
import { listDatabases, listObjects } from "../metadata.js";
import { requireSession } from "../sessions.js";
import { catalog } from "./catalog.js";
import { FakerError, runFaker } from "./engine.js";
import { FakerFileError, readFakerFile, writeFakerFile } from "./fakerfile.js";
import type { GenerateRequest, TableRule } from "./rules.js";
import { tableInfo } from "./schema.js";
import { deleteFaker, fakersFolder, listFakers, readFaker, renameFaker, requireFolder, writeFaker } from "./store.js";
import { suggestTable } from "./suggest.js";

type Params = Record<string, unknown>;

const str = (p: Params, key: string): string => {
  const v = p[key];
  if (typeof v !== "string" || !v) throw new FakerError(`Missing "${key}".`);
  return v;
};
const optStr = (p: Params, key: string): string | undefined => (typeof p[key] === "string" && p[key] ? (p[key] as string) : undefined);

function asRule(v: unknown): TableRule {
  const r = v as TableRule | undefined;
  if (!r || typeof r.schema !== "string" || typeof r.table !== "string" || !Array.isArray(r.columns)) throw new FakerError("The faker configuration is incomplete.");
  return r;
}

function asRequest(p: Params): GenerateRequest {
  const count = Number(p.count);
  if (!Number.isFinite(count) || count < 1) throw new FakerError("Enter how many rows to generate (1 or more).");
  const seed = p.seed === undefined || p.seed === null || p.seed === "" ? undefined : Number(p.seed);
  return { database: str(p, "database"), rule: asRule(p.rule), count, ...(seed !== undefined && Number.isFinite(seed) ? { seed } : {}) };
}

const userDatabases = async (cid: string) => (await listDatabases(requireSession(cid).pool)).filter((d) => d.database_id > 4 && d.state_desc === "ONLINE").map((d) => d.name);

/** The Fake Data view's backend (`mssql.faker` command). Fakers are `*.faker.json` files in the connection's fakers folder. */
const API: Record<string, (connectionId: string, p: Params) => Promise<unknown> | unknown> = {
  /**
   * Everything the editor needs: a faker file (by `file`), or a new faker for a table. Without a database and/or table
   * the view first asks for them (`databases` / `tables` in the answer).
   */
  load: async (cid, p) => {
    const { pool } = requireSession(cid);
    const folder = fakersFolder(cid) ?? null;
    const file = optStr(p, "file");
    const doc = file ? await readFaker(requireFolder(cid), file) : undefined;
    const database = optStr(p, "database") ?? doc?.database;
    if (!database) return { folder, databases: await userDatabases(cid), catalog: catalog() };
    const schema = doc?.rule.schema ?? optStr(p, "schema");
    const table = doc?.rule.table ?? optStr(p, "table");
    if (!schema || !table) return { folder, database, tables: (await listObjects(pool, database, "tables")).map((t) => `${t.schema}.${t.name}`), catalog: catalog() };
    const info = await tableInfo(pool, database, schema, table);
    const suggested = suggestTable(info);
    return {
      folder,
      database,
      // Where a run goes: shown (and the database switchable) at the top of the editor.
      target: describeConnection(requireSession(cid).config),
      databases: await userDatabases(cid),
      info,
      suggested,
      rule: doc ? { ...doc.rule, columns: mergeColumns(doc.rule, suggested) } : suggested,
      faker: doc ? { file, name: doc.name, count: doc.count, seed: doc.seed ?? null, database: doc.database ?? null } : null,
      catalog: catalog(),
    };
  },
  /** Metadata of another table: for a "Create new rows" foreign key's parent, or a nested child. */
  table: async (cid, p) => {
    const info = await tableInfo(requireSession(cid).pool, str(p, "database"), str(p, "schema"), str(p, "table"));
    return { info, suggested: suggestTable(info) };
  },
  preview: (cid, p) => runFaker(requireSession(cid).pool, asRequest(p), false),
  generate: (cid, p) => runFaker(requireSession(cid).pool, asRequest(p), true),
  save: async (cid, p) => {
    const req = asRequest(p);
    const root = requireFolder(cid);
    const name = str(p, "name").trim();
    const doc = { name, database: p.anyDatabase === true ? undefined : req.database, count: req.count, seed: req.seed, rule: req.rule };
    const file = await writeFaker(root, doc, optStr(p, "file"));
    return { file, name };
  },
  /** The file content for the JSON tab. */
  toJson: (_cid, p) => {
    const req = asRequest(p);
    return JSON.stringify(writeFakerFile({ name: optStr(p, "name") ?? `${req.rule.table} faker`, database: p.anyDatabase === true ? undefined : req.database, count: req.count, seed: req.seed, rule: req.rule }), null, 2);
  },
  /** JSON tab → editor state (validated). */
  fromJson: (_cid, p) => {
    let raw: unknown;
    try {
      raw = JSON.parse(str(p, "text"));
    } catch (err) {
      throw new FakerError(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return readFakerFile(raw, "the JSON");
  },
};

/** Saved column rules first, then suggestions for columns the file doesn't mention (so the editor shows every column). */
function mergeColumns(saved: TableRule, suggested: TableRule): TableRule["columns"] {
  const known = new Set(saved.columns.map((c) => c.column));
  return [...saved.columns, ...suggested.columns.filter((c) => !known.has(c.column))];
}

export type FakerApiResult = { ok: true; data: unknown } | { ok: false; error: string };

export async function callFakerApi(connectionId: string | undefined, method: string, params: Params): Promise<FakerApiResult> {
  try {
    if (!connectionId) throw new FakerError("No connection id provided.");
    const handler = API[method];
    if (!handler) throw new FakerError(`Unknown operation "${method}".`);
    return { ok: true, data: await handler(connectionId, params) };
  } catch (err) {
    return { ok: false, error: err instanceof FakerError || err instanceof FakerFileError ? err.message : err instanceof Error && !("number" in err) ? err.message : describeError(err) };
  }
}

// ---- the FAKERS sidebar section ------------------------------------------------------------------------------

export const FAKER_ICON = "$(wrench)";

/** The editor tab for a faker file, or a new one (optionally for a database / table). */
export function fakerTab(params: Record<string, string>, title: string): TreeNode {
  return {
    id: params.file ? `faker:${params.file}` : `faker-new:${Date.now()}`,
    label: title,
    nodeType: "mssql.fakerEditor",
    collapsible: "none",
    openView: { viewId: "mssql.faker", title, params, icon: FAKER_ICON },
  };
}

/**
 * Children of the section's per-connection root: the attached folder, then fakers grouped by database
 * (fakers that don't name one are under "Any database"); unreadable files are listed with their problem.
 */
export async function fakerSectionNodes(connectionId: string, node: TreeNode): Promise<TreeNode[]> {
  const folder = fakersFolder(connectionId);
  if (node.nodeType === "mssql.fakersRoot") {
    if (!folder) {
      return [{ id: "fakers:none", label: "No folder attached — right-click to attach one", nodeType: "mssql.fakerHint", collapsible: "none", icon: "$(folder)", contextValue: "mssql.fakersRoot" }];
    }
    const fakers = await listFakers(folder);
    const groups = [...new Set(fakers.filter((f) => !f.error).map((f) => f.database ?? ""))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
    const nodes: TreeNode[] = [
      { id: "fakers:folder", label: folder, nodeType: "mssql.fakersFolder", collapsible: "none", icon: "$(folder-opened)", contextValue: "mssql.fakersFolder" },
      ...groups.map(
        (db): TreeNode => ({
          id: `fakers:db:${db}`,
          label: db || "Any database",
          nodeType: "mssql.fakerGroup",
          collapsible: "expanded",
          icon: "$(database)",
          contextValue: "mssql.fakerGroup",
          data: { database: db },
        }),
      ),
      ...fakers
        .filter((f) => f.error)
        .map((f): TreeNode => ({ id: `fakers:bad:${f.file}`, label: `⚠ ${f.file} — ${f.error}`, nodeType: "mssql.fakerBroken", collapsible: "none", contextValue: "mssql.fakerBroken", data: { fakerFile: f.file } })),
    ];
    if (fakers.length === 0) nodes.push({ id: "fakers:empty", label: "No fakers yet — right-click → New Faker…", nodeType: "mssql.fakerHint", collapsible: "none", contextValue: "mssql.fakersRoot" });
    return nodes;
  }
  if (node.nodeType === "mssql.fakerGroup" && folder) {
    const db = (node.data as { database?: string } | undefined)?.database ?? "";
    return (await listFakers(folder))
      .filter((f) => !f.error && (f.database ?? "") === db)
      .map((f) => ({
        id: `faker:${f.file}`,
        label: f.name,
        nodeType: "mssql.faker",
        collapsible: "none",
        icon: FAKER_ICON,
        contextValue: "mssql.faker",
        data: { fakerFile: f.file, ...(db ? { database: db } : {}) },
        openView: { viewId: "mssql.faker", title: f.name, params: { file: f.file, ...(db ? { database: db } : {}) }, icon: FAKER_ICON },
      }));
  }
  return [];
}

/** "Run Faker" from the tree. A faker without a database runs in `database` (the group it was listed in) or fails clearly. */
export async function runSavedFaker(connectionId: string, file: string, database?: string) {
  const doc = await readFaker(requireFolder(connectionId), file);
  const db = doc.database ?? database;
  if (!db) throw new FakerError(`"${doc.name}" doesn't name a database — open it and run it from the editor.`);
  const result = await runFaker(requireSession(connectionId).pool, { database: db, rule: doc.rule, count: doc.count, ...(doc.seed !== undefined ? { seed: doc.seed } : {}) }, true);
  return { doc, database: db, result };
}

export async function renameSavedFaker(connectionId: string, file: string, name: string) {
  if (!name.trim()) throw new FakerError("Give the faker a name.");
  return renameFaker(requireFolder(connectionId), file, name);
}

export async function deleteSavedFaker(connectionId: string, file: string) {
  await deleteFaker(requireFolder(connectionId), file);
}
