import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type FakerDoc, readFakerFile, writeFakerFile } from "./fakerfile.js";

/**
 * Fakers live as `*.faker.json` files in a folder the user attaches to a SQL Server connection — so they can be kept
 * in a repo next to the schema, shared and reviewed. Which folder belongs to which connection is remembered here.
 */

const FOLDERS_VERSION = 1;
const EXT = ".faker.json";
const MAX_DEPTH = 6;

function foldersFile(): string {
  return join(process.env.ONECLIENT_HOME?.trim() || join(homedir(), ".oneclient"), "mssql", "faker-folders.json");
}

function readFolders(): Record<string, string> {
  const file = foldersFile();
  if (!existsSync(file)) return {};
  try {
    const doc = JSON.parse(readFileSync(file, "utf-8")) as { version?: number; folders?: Record<string, string> };
    if ((doc.version ?? 1) > FOLDERS_VERSION) return {};
    return doc.folders ?? {};
  } catch {
    return {};
  }
}

function writeFolders(folders: Record<string, string>): void {
  const file = foldersFile();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ version: FOLDERS_VERSION, folders }, null, 2)}\n`, "utf-8");
  renameSync(`${file}.tmp`, file);
}

export function fakersFolder(connectionId: string): string | undefined {
  return readFolders()[connectionId];
}

export async function attachFolder(connectionId: string, folder: string): Promise<string> {
  const abs = resolve(folder.trim());
  const info = await stat(abs).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`"${folder}" is not a folder.`);
  writeFolders({ ...readFolders(), [connectionId]: abs });
  return abs;
}

export function detachFolder(connectionId: string): void {
  const all = readFolders();
  delete all[connectionId];
  writeFolders(all);
}

export function requireFolder(connectionId: string): string {
  const folder = fakersFolder(connectionId);
  if (!folder) throw new Error("No fakers folder is attached — right-click the connection → Attach Fakers Folder….");
  return folder;
}

/** A root-relative "/" path → absolute path, refusing anything outside the folder. */
function inFolder(root: string, rel: string): string {
  const abs = resolve(root, ...rel.split("/").filter(Boolean));
  const r = relative(root, abs);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) throw new Error(`"${rel}" is outside the fakers folder.`);
  return abs;
}

export interface FakerEntry {
  /** Root-relative path, "/"-separated. */
  file: string;
  name: string;
  database?: string | undefined;
  table?: string;
  /** The file couldn't be read — shown so it can be fixed rather than silently ignored. */
  error?: string;
}

/** Every `*.faker.json` under the folder (sub-folders included). */
export async function listFakers(root: string): Promise<FakerEntry[]> {
  const out: FakerEntry[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && e.name !== "node_modules") await walk(abs, depth + 1);
      } else if (e.name.toLowerCase().endsWith(EXT)) {
        const file = relative(root, abs).split(sep).join("/");
        try {
          const doc = readFakerFile(JSON.parse(await readFile(abs, "utf-8")), file);
          out.push({ file, name: doc.name, database: doc.database, table: `${doc.rule.schema}.${doc.rule.table}` });
        } catch (err) {
          out.push({ file, name: e.name.slice(0, -EXT.length), error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  };
  await walk(root, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export async function readFaker(root: string, file: string): Promise<FakerDoc> {
  const text = await readFile(inFolder(root, file), "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return readFakerFile(raw, file);
}

const slug = (name: string) =>
  name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80) || "faker";

/** Writes the faker; a new one goes to the folder root as `<name>.faker.json`. Returns its root-relative path. */
export async function writeFaker(root: string, doc: FakerDoc, file?: string): Promise<string> {
  let target = file;
  if (!target) {
    target = `${slug(doc.name)}${EXT}`;
    for (let n = 2; existsSync(inFolder(root, target)); n++) target = `${slug(doc.name)}-${n}${EXT}`;
  }
  const abs = inFolder(root, target);
  await writeFile(`${abs}.tmp`, `${JSON.stringify(writeFakerFile(doc), null, 2)}\n`, "utf-8");
  await rename(`${abs}.tmp`, abs);
  return target;
}

/** Renames the faker (its `name`) and its file, keeping it in the same sub-folder. */
export async function renameFaker(root: string, file: string, name: string): Promise<string> {
  const doc = await readFaker(root, file);
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  let target = `${dir}${slug(name)}${EXT}`;
  for (let n = 2; target.toLowerCase() !== file.toLowerCase() && existsSync(inFolder(root, target)); n++) target = `${dir}${slug(name)}-${n}${EXT}`;
  await writeFaker(root, { ...doc, name: name.trim() }, file);
  if (target.toLowerCase() !== file.toLowerCase()) await rename(inFolder(root, file), inFolder(root, target));
  return target;
}

export async function deleteFaker(root: string, file: string): Promise<void> {
  await rm(inFolder(root, file));
}
