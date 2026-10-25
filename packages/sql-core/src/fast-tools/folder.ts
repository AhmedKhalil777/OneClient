import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { dataHome } from "../paths.js";

/**
 * The Fast Tools folder: one folder per connection, attached by the user, holding every Fast Tool's files
 * (`*.query.sql`, `*.faker.json`, …) — so they can be kept in a repo next to the schema, shared and reviewed.
 * Which folder belongs to which connection is remembered in `~/.oneclient/<dataDir>/fast-tools-folders.json`.
 */

const FOLDERS_VERSION = 1;
const MAX_DEPTH = 6;
/** Written by the SQL Server plugin before Fast Tools (fakers only); still read when the new file doesn't exist. */
const LEGACY_FILE = "faker-folders.json";

export interface FolderStore {
  get(connectionId: string): string | undefined;
  /** The folder, or a clear error telling the user how to attach one. */
  require(connectionId: string): string;
  attach(connectionId: string, folder: string): Promise<string>;
  detach(connectionId: string): void;
}

export function createFolderStore(dataDir: string): FolderStore {
  const fileOf = (name: string) => join(dataHome(), dataDir, name);

  function read(): Record<string, string> {
    let file = fileOf("fast-tools-folders.json");
    if (!existsSync(file)) file = fileOf(LEGACY_FILE);
    if (!existsSync(file)) return {};
    try {
      const doc = JSON.parse(readFileSync(file, "utf-8")) as { version?: number; folders?: Record<string, string> };
      if ((doc.version ?? 1) > FOLDERS_VERSION) return {};
      return doc.folders ?? {};
    } catch {
      return {};
    }
  }

  function write(folders: Record<string, string>): void {
    const file = fileOf("fast-tools-folders.json");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ version: FOLDERS_VERSION, folders }, null, 2)}
`, "utf-8");
    renameSync(`${file}.tmp`, file);
  }

  return {
    get: (connectionId) => read()[connectionId],
    require(connectionId) {
      const folder = read()[connectionId];
      if (!folder) throw new Error("No Fast Tools folder is attached — right-click the connection in FAST TOOLS → Attach Fast Tools Folder….");
      return folder;
    },
    async attach(connectionId, folder) {
      const abs = resolve(folder.trim());
      const info = await stat(abs).catch(() => null);
      if (!info?.isDirectory()) throw new Error(`"${folder}" is not a folder.`);
      write({ ...read(), [connectionId]: abs });
      return abs;
    },
    detach(connectionId) {
      const all = read();
      delete all[connectionId];
      write(all);
    },
  };
}

/** A root-relative "/" path → absolute path, refusing anything outside the folder. */
export function inFolder(root: string, rel: string): string {
  const abs = resolve(root, ...rel.split("/").filter(Boolean));
  const r = relative(root, abs);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) throw new Error(`"${rel}" is outside the Fast Tools folder.`);
  return abs;
}

/** A file name from a display name ("Blocking sessions" → "Blocking-sessions"). */
export const slug = (name: string, fallback: string) =>
  name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80) || fallback;

/** A root-relative path `<dir><slug(name)><ext>` that doesn't exist yet (or is `keep`, the file being renamed). */
export function freeName(root: string, dir: string, name: string, ext: string, fallback: string, keep?: string): string {
  const base = `${dir}${slug(name, fallback)}`;
  let target = `${base}${ext}`;
  for (let n = 2; target.toLowerCase() !== keep?.toLowerCase() && existsSync(inFolder(root, target)); n++) target = `${base}-${n}${ext}`;
  return target;
}

/** Root-relative ("/"-separated) paths of every file under the folder whose name ends with `ext` (sub-folders included). */
export async function findFiles(root: string, ext: string): Promise<string[]> {
  const out: string[] = [];
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
      } else if (e.name.toLowerCase().endsWith(ext)) {
        out.push(relative(root, abs).split(sep).join("/"));
      }
    }
  };
  await walk(root, 0);
  return out;
}
