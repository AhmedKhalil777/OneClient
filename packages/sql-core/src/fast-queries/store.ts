import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findFiles, freeName, inFolder } from "../fast-tools/folder.js";
import { FAST_QUERY_EXT, type FastQueryDoc, readFastQuery, writeFastQuery } from "./file.js";

/** Fast queries are `*.query.sql` files in the connection's Fast Tools folder (see ../fast-tools/folder.ts). */

export interface FastQueryEntry extends FastQueryDoc {
  /** Root-relative path, "/"-separated. */
  file: string;
}

export async function listFastQueries(root: string): Promise<FastQueryEntry[]> {
  const out: FastQueryEntry[] = [];
  for (const file of await findFiles(root, FAST_QUERY_EXT)) {
    try {
      out.push({ file, ...readFastQuery(await readFile(join(root, file), "utf-8"), file) });
    } catch {
      // unreadable (deleted mid-listing, permissions): skip
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

export async function readFastQueryFile(root: string, file: string): Promise<FastQueryDoc> {
  return readFastQuery(await readFile(inFolder(root, file), "utf-8"), file);
}

/** Writes the query; a new one goes to the folder root as `<name>.query.sql`. Returns its root-relative path. */
export async function writeFastQueryFile(root: string, doc: FastQueryDoc, file?: string): Promise<string> {
  const target = file ?? freeName(root, "", doc.name, FAST_QUERY_EXT, "query");
  const abs = inFolder(root, target);
  await writeFile(`${abs}.tmp`, writeFastQuery(doc), "utf-8");
  await rename(`${abs}.tmp`, abs);
  return target;
}

/** Renames the query (its `name`) and its file, keeping it in the same sub-folder. */
export async function renameFastQueryFile(root: string, file: string, name: string): Promise<string> {
  const doc = await readFastQueryFile(root, file);
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const target = freeName(root, dir, name, FAST_QUERY_EXT, "query", file);
  await writeFastQueryFile(root, { ...doc, name: name.trim() }, file);
  if (target.toLowerCase() !== file.toLowerCase()) await rename(inFolder(root, file), inFolder(root, target));
  return target;
}

export async function deleteFastQueryFile(root: string, file: string): Promise<void> {
  await rm(inFolder(root, file));
}
