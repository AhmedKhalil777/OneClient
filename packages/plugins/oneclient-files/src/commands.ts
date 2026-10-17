import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { CommandHandler, TreeNode } from "@oneclient/plugin-api";
import { fileNode } from "./explorer-provider.js";
import { reveal } from "./editor-hub.js";
import { joinRel, requireRoot, resolveInRoot } from "./roots.js";
import { type FindOptions, type ReplaceOptions, findInFiles, quickOpen, replaceInFiles } from "./search.js";

/** Bigger than this and a plain-text editor stops being useful (and the IPC payload gets silly). */
const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;

interface FileArg {
  connectionId: string;
  path: string;
}
interface WriteArg extends FileArg {
  content: string;
}

export type ReadResult =
  | { ok: true; content: string; eol: "\n" | "\r\n"; bom: boolean; size: number }
  | { ok: false; error: string; reason?: "binary" | "tooLarge" };

export type WriteResult = { ok: true; size: number } | { ok: false; error: string };

/** `openNode` asks core to open that node's view (the new file's editor) — see the `when` docs in plugin-api. */
type ActionResult = { ok: true; openNode?: TreeNode } | { ok: false; error: string };

/** Context-menu args: `path` is the right-clicked entry's (absent on the root connection row). */
interface EntryArg {
  connectionId: string;
  path?: string;
}

/** A single path segment: no separators, not "." / "..", and nothing Windows refuses. */
function validName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new Error("A name is required.");
  if (/[\\/]/.test(name)) throw new Error("Use a single name, without / or \\.");
  if (name === "." || name === "..") throw new Error(`"${name}" is not a valid name.`);
  if (process.platform === "win32" && /[<>:"|?*]/.test(name)) throw new Error('Names can\'t contain < > : " | ? *');
  return name;
}

function parentOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? "" : relPath.slice(0, i);
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

function arg<T>(args: unknown[]): T {
  const value = args[0] as T | undefined;
  if (!value) throw new Error("Missing command argument.");
  return value;
}

/** Backs the editor view (via `ViewHostApi.invokeCommand`); each call carries the view's own connectionId. */
/** Runs a search command, turning any failure (bad regex, folder not open…) into `{ ok: false, error }` for the view. */
async function searchAction<T extends object>(fn: () => Promise<T>): Promise<({ ok: true } & T) | { ok: false; error: string }> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createCommandHandlers(): CommandHandler[] {
  return [
    // Global search provider (top bar): file names in this folder, best match first.
    {
      commandId: "files.search",
      execute: async (args) => {
        const { connectionId, query, limit } = arg<{ connectionId: string; query: string; limit?: number }>(args);
        return quickOpen(connectionId, requireRoot(connectionId), String(query ?? ""), Math.min(50, Math.max(1, limit ?? 20)));
      },
    },
    // Search view: find / replace text in the folder's files.
    {
      commandId: "files.find",
      execute: (args) => {
        const { connectionId, ...options } = arg<{ connectionId: string } & FindOptions>(args);
        return searchAction(() => findInFiles(requireRoot(connectionId), options));
      },
    },
    {
      commandId: "files.replace",
      execute: (args) => {
        const { connectionId, ...options } = arg<{ connectionId: string } & ReplaceOptions>(args);
        return searchAction(() => replaceInFiles(requireRoot(connectionId), options));
      },
    },
    {
      commandId: "files.reveal",
      execute: (args) => {
        const { connectionId, path, line, col, length } = arg<{ connectionId: string; path: string; line: number; col: number; length: number }>(args);
        reveal(connectionId, { path, line: Number(line) || 1, col: Number(col) || 1, length: Number(length) || 0 });
        return { ok: true };
      },
    },
    {
      commandId: "files.newFile",
      execute: (args) =>
        action(async () => {
          const { connectionId, path = "", name } = arg<EntryArg & { name: unknown }>(args);
          const rel = joinRel(path, validName(name));
          const root = requireRoot(connectionId);
          // "wx" fails instead of truncating if the file already exists.
          await writeFile(resolveInRoot(root, rel), "", { flag: "wx" });
          return { ok: true, openNode: fileNode(root, rel) };
        }),
    },
    {
      commandId: "files.newFolder",
      execute: (args) =>
        action(async () => {
          const { connectionId, path = "", name } = arg<EntryArg & { name: unknown }>(args);
          await mkdir(resolveInRoot(requireRoot(connectionId), joinRel(path, validName(name))));
          return { ok: true };
        }),
    },
    {
      commandId: "files.rename",
      execute: (args) =>
        action(async () => {
          const { connectionId, path, newName } = arg<EntryArg & { newName: unknown }>(args);
          if (!path) throw new Error("Can't rename the open folder itself.");
          const root = requireRoot(connectionId);
          const target = resolveInRoot(root, joinRel(parentOf(path), validName(newName)));
          const source = resolveInRoot(root, path);
          // Allow case-only renames (same path on case-insensitive filesystems); otherwise never overwrite.
          if (target.toLowerCase() !== source.toLowerCase() && (await exists(target))) {
            return { ok: false, error: "Something with that name already exists here." };
          }
          await rename(source, target);
          return { ok: true };
        }),
    },
    {
      commandId: "files.delete",
      execute: (args) =>
        action(async () => {
          const { connectionId, path } = arg<EntryArg>(args);
          if (!path) throw new Error("Can't delete the open folder itself.");
          await rm(resolveInRoot(requireRoot(connectionId), path), { recursive: true });
          return { ok: true };
        }),
    },
    {
      commandId: "files.readFile",
      async execute(args): Promise<ReadResult> {
        const { connectionId, path } = arg<FileArg>(args);
        try {
          const absolute = resolveInRoot(requireRoot(connectionId), path);
          const info = await stat(absolute);
          if (info.size > MAX_EDITABLE_BYTES) {
            return { ok: false, reason: "tooLarge", error: `File is ${formatBytes(info.size)} — too large to open in the editor.` };
          }
          const buffer = await readFile(absolute);
          if (looksBinary(buffer)) {
            return { ok: false, reason: "binary", error: "This file is binary or uses an unsupported text encoding." };
          }
          const bom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
          const content = buffer.toString("utf-8", bom ? 3 : 0);
          return { ok: true, content, eol: content.includes("\r\n") ? "\r\n" : "\n", bom, size: info.size };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      commandId: "files.writeFile",
      async execute(args): Promise<WriteResult> {
        const { connectionId, path, content } = arg<WriteArg>(args);
        if (typeof content !== "string") return { ok: false, error: "Missing file content." };
        try {
          const absolute = resolveInRoot(requireRoot(connectionId), path);
          // Callers send the exact bytes to write (EOL/BOM already restored), so this stays a plain write.
          await writeFile(absolute, content, "utf-8");
          return { ok: true, size: Buffer.byteLength(content, "utf-8") };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}

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
