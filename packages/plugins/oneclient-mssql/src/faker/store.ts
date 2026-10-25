import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findFiles, freeName, inFolder } from "@oneclient/sql-core";
import { type FakerDoc, readFakerFile, writeFakerFile } from "./fakerfile.js";

/** Fakers are `*.faker.json` files in the connection's Fast Tools folder (see ../folders.ts). */

const EXT = ".faker.json";

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
  for (const file of await findFiles(root, EXT)) {
    try {
      const doc = readFakerFile(JSON.parse(await readFile(join(root, file), "utf-8")), file);
      out.push({ file, name: doc.name, database: doc.database, table: `${doc.rule.schema}.${doc.rule.table}` });
    } catch (err) {
      out.push({ file, name: file.slice(file.lastIndexOf("/") + 1, -EXT.length), error: err instanceof Error ? err.message : String(err) });
    }
  }
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

/** Writes the faker; a new one goes to the folder root as `<name>.faker.json`. Returns its root-relative path. */
export async function writeFaker(root: string, doc: FakerDoc, file?: string): Promise<string> {
  const target = file ?? freeName(root, "", doc.name, EXT, "faker");
  const abs = inFolder(root, target);
  await writeFile(`${abs}.tmp`, `${JSON.stringify(writeFakerFile(doc), null, 2)}\n`, "utf-8");
  await rename(`${abs}.tmp`, abs);
  return target;
}

/** Renames the faker (its `name`) and its file, keeping it in the same sub-folder. */
export async function renameFaker(root: string, file: string, name: string): Promise<string> {
  const doc = await readFaker(root, file);
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const target = freeName(root, dir, name, EXT, "faker", file);
  await writeFaker(root, { ...doc, name: name.trim() }, file);
  if (target.toLowerCase() !== file.toLowerCase()) await rename(inFolder(root, file), inFolder(root, target));
  return target;
}

export async function deleteFaker(root: string, file: string): Promise<void> {
  await rm(inFolder(root, file));
}
