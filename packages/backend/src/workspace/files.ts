import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TreeNode } from "@oneclient/plugin-api";

/**
 * The Explorer's file operations: listing a folder for the tree, and reading, writing, creating, renaming and
 * deleting entries. Every path is "/"-separated and relative to an open workspace folder, and can never escape it.
 */

/** Bigger than this and a plain-text editor stops being useful (and the IPC payload gets silly). */
const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;
/** Same idea as VS Code's default `files.exclude`. */
const HIDDEN = new Set([".git", ".svn", ".hg", ".DS_Store", "Thumbs.db"]);

/** Tree node types / context values — plugins' `when` clauses use these (e.g. "Open in Terminal"). */
export const NODE_DIRECTORY = "files.directory";
export const NODE_FILE = "files.file";
/** The core editor view (a file's tab). */
export const EDITOR_VIEW = "files.editor";

export interface EntryData {
  /** Folder-relative, "/"-separated; "" is the folder itself. */
  path: string;
  /** Absolute path on disk — lets plugins act on it (e.g. open a terminal there). */
  fsPath: string;
}

/** Resolves a folder-relative path, refusing anything that escapes the folder (e.g. `../../etc/passwd`). */
export function resolveInRoot(root: string, relPath: string): string {
  const absolute = resolve(root, ...relPath.split("/").filter(Boolean));
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path "${relPath}" is outside the open folder.`);
  return absolute;
}

export const joinRel = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name);
const baseName = (relPath: string): string => relPath.slice(relPath.lastIndexOf("/") + 1);
const parentOf = (relPath: string): string => (relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "");

/** A single path segment: no separators, not "." / "..", and nothing Windows refuses. */
export function validName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new Error("A name is required.");
  if (/[\\/]/.test(name)) throw new Error("Use a single name, without / or \\.");
  if (name === "." || name === "..") throw new Error(`"${name}" is not a valid name.`);
  if (process.platform === "win32" && /[<>:"|?*]/.test(name)) throw new Error('Names can\'t contain < > : " | ? *');
  return name;
}

export function directoryNode(root: string, path: string): TreeNode {
  const name = baseName(path);
  return {
    id: path,
    label: name,
    nodeType: NODE_DIRECTORY,
    collapsible: "collapsed",
    icon: "$(folder)",
    contextValue: NODE_DIRECTORY,
    // The icon theme's folder-name mappings win; $(folder) is the fallback.
    resource: { name, kind: "folder" },
    data: { path, fsPath: resolveInRoot(root, path) } satisfies EntryData,
  };
}

/** Clicking a file opens it in the editor — one tab per file. */
export function fileNode(root: string, path: string): TreeNode {
  const name = baseName(path);
  return {
    id: path,
    label: name,
    nodeType: NODE_FILE,
    collapsible: "none",
    icon: "$(file)",
    contextValue: NODE_FILE,
    resource: { name, kind: "file" },
    data: { path, fsPath: resolveInRoot(root, path) } satisfies EntryData,
    openView: { viewId: EDITOR_VIEW, title: name, params: { path } },
  };
}

/**
 * One directory per expand — nothing is walked ahead of time, so a huge folder (or one with node_modules) opens
 * instantly. Folders first, then files, each sorted case-insensitively like VS Code.
 */
export async function listDirectory(root: string, node: TreeNode | null): Promise<TreeNode[]> {
  if (node && node.nodeType !== NODE_DIRECTORY) return [];
  const dirRel = node ? (node.data as EntryData).path : "";
  const entries = await readdir(resolveInRoot(root, dirRel), { withFileTypes: true });
  const visible = entries.filter((e) => !HIDDEN.has(e.name));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const dirs = visible.filter((e) => e.isDirectory()).sort(byName);
  const files = visible.filter((e) => !e.isDirectory()).sort(byName);
  return [...dirs.map((d) => directoryNode(root, joinRel(dirRel, d.name))), ...files.map((f) => fileNode(root, joinRel(dirRel, f.name)))];
}

export type ReadResult =
  | { ok: true; content: string; eol: "\n" | "\r\n"; bom: boolean; size: number }
  | { ok: false; error: string; reason?: "binary" | "tooLarge" };
export type WriteResult = { ok: true; size: number } | { ok: false; error: string };
export type ActionResult = { ok: true; openNode?: TreeNode } | { ok: false; error: string };

export async function readTextFile(root: string, path: string): Promise<ReadResult> {
  try {
    const absolute = resolveInRoot(root, path);
    const info = await stat(absolute);
    if (info.size > MAX_EDITABLE_BYTES) return { ok: false, reason: "tooLarge", error: `File is ${formatBytes(info.size)} — too large to open in the editor.` };
    const buffer = await readFile(absolute);
    if (looksBinary(buffer)) return { ok: false, reason: "binary", error: "This file is binary or uses an unsupported text encoding." };
    const bom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    const content = buffer.toString("utf-8", bom ? 3 : 0);
    return { ok: true, content, eol: content.includes("\r\n") ? "\r\n" : "\n", bom, size: info.size };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Writes the exact text the editor sends (it has already restored the file's line endings and BOM). */
export async function writeTextFile(root: string, path: string, content: unknown): Promise<WriteResult> {
  if (typeof content !== "string") return { ok: false, error: "Missing file content." };
  try {
    await writeFile(resolveInRoot(root, path), content, "utf-8");
    return { ok: true, size: Buffer.byteLength(content, "utf-8") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function action(fn: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await fn();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return { ok: false, error: "Something with that name already exists here." };
    return { ok: false, error: e.message ?? String(err) };
  }
}

/** Creates an empty file and returns its node (so the shell opens it). "wx" fails instead of truncating. */
export const newFile = (root: string, dir: string, name: unknown) =>
  action(async () => {
    // A name with "/" creates the file in sub-folders (File ▸ New File: "src/new.ts").
    const parts = typeof name === "string" ? name.split(/[\\/]/).filter(Boolean) : [];
    if (parts.length === 0) throw new Error("A name is required.");
    const rel = parts.map(validName).reduce((acc, p) => joinRel(acc, p), dir);
    if (parts.length > 1) await mkdir(resolveInRoot(root, parentOf(rel)), { recursive: true });
    await writeFile(resolveInRoot(root, rel), "", { flag: "wx" });
    return { ok: true, openNode: fileNode(root, rel) };
  });

export const newFolder = (root: string, dir: string, name: unknown) =>
  action(async () => {
    await mkdir(resolveInRoot(root, joinRel(dir, validName(name))));
    return { ok: true };
  });

export const renameEntry = (root: string, path: string, newName: unknown) =>
  action(async () => {
    if (!path) throw new Error("Can't rename the open folder itself.");
    const target = resolveInRoot(root, joinRel(parentOf(path), validName(newName)));
    const source = resolveInRoot(root, path);
    // Case-only renames are allowed (same path on case-insensitive file systems); otherwise never overwrite.
    if (target.toLowerCase() !== source.toLowerCase() && (await exists(target))) return { ok: false, error: "Something with that name already exists here." };
    await rename(source, target);
    return { ok: true };
  });

export const deleteEntry = (root: string, path: string) =>
  action(async () => {
    if (!path) throw new Error("Can't delete the open folder itself.");
    await rm(resolveInRoot(root, path), { recursive: true });
    return { ok: true };
  });

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Same heuristic git uses: a NUL byte in the first 8 KB means "binary". */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}
