import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ToolCall, ToolDef, ToolResult } from "./types.js";

/**
 * What the assistant can do with your open folders: look around (read-only, no questions asked) and change
 * files (every change is shown to you first and waits for Approve). It cannot leave the folders open in the
 * Explorer, and it has no shell.
 */

export interface Folder {
  name: string;
  path: string;
}

export interface ToolHost {
  folders(): Promise<Folder[]>;
  /** Ask the user; resolves true on Approve. `summary` is what they are approving. */
  approve(call: ToolCall, summary: string): Promise<boolean>;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "bin", "obj", ".next", ".vs", ".idea", "target", "__pycache__", ".venv"]);
const MAX_READ_BYTES = 400_000;
const MAX_LINES = 2000;
const MAX_LIST = 400;
const MAX_MATCHES = 120;
const MAX_FILE_SCAN = 6000;

export const TOOLS: ToolDef[] = [
  {
    name: "list_files",
    description: "List files and folders. Without a path, lists the folders open in the app. `path` is absolute or starts with a folder's name.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list. Omit to list the open folders." },
        depth: { type: "integer", description: "How many levels to descend (1-4, default 1).", minimum: 1, maximum: 4 },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a text file with line numbers. Large files are cut; use start_line / end_line to read a range.",
    schema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
    },
  },
  {
    name: "search_files",
    description: "Search file contents with a regular expression (case-insensitive). Skips node_modules, .git, build output and binary files.",
    schema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: { type: "string", description: "Directory to search; defaults to all open folders." },
        glob: { type: "string", description: "Only files whose name matches, e.g. *.ts or Program.cs" },
      },
    },
  },
  {
    name: "edit_file",
    description: "Replace one exact piece of text in a file. `old_text` must occur exactly once. The user approves each edit.",
    schema: {
      type: "object",
      required: ["path", "old_text", "new_text"],
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
    },
  },
  {
    name: "write_file",
    description: "Create a file or overwrite it with the full content. Prefer edit_file for changes. The user approves each write.",
    schema: {
      type: "object",
      required: ["path", "content"],
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
  },
];

export const WRITE_TOOLS = new Set(["edit_file", "write_file"]);

/** Resolves what the model wrote to an absolute path inside an open folder, or throws a message it can act on. */
export function resolveInFolders(folders: readonly Folder[], input: unknown): string {
  if (!folders.length) throw new Error("No folder is open in the Explorer, so there is nothing to work with. Ask the user to open one.");
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw new Error("A path is required.");
  const candidates: string[] = [];
  if (isAbsolute(raw)) candidates.push(resolve(raw));
  else {
    const norm = raw.replace(/\\/g, "/");
    for (const f of folders) {
      if (norm === f.name || norm.startsWith(`${f.name}/`)) candidates.push(resolve(f.path, norm.slice(f.name.length + 1)));
    }
    if (folders.length === 1 || !candidates.length) candidates.push(resolve(folders[0]!.path, norm));
  }
  for (const c of candidates) {
    for (const f of folders) {
      const rel = relative(resolve(f.path), c);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return c;
    }
  }
  throw new Error(`"${raw}" is outside the open folders (${folders.map((f) => f.name).join(", ")}).`);
}

const text = (s: string, isError = false) => ({ content: s, isError });

export async function runTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const done = (r: { content: string; isError: boolean }): ToolResult => ({ id: call.id, name: call.name, content: r.content, ...(r.isError ? { isError: true } : {}) });
  try {
    const folders = await host.folders();
    const a = call.input;
    switch (call.name) {
      case "list_files":
        return done(await listFiles(folders, a));
      case "read_file":
        return done(await readFileTool(folders, a));
      case "search_files":
        return done(await searchFiles(folders, a));
      case "edit_file":
        return done(await editFile(folders, a, call, host));
      case "write_file":
        return done(await writeFileTool(folders, a, call, host));
      default:
        return done(text(`Unknown tool "${call.name}".`, true));
    }
  } catch (err) {
    return done(text(err instanceof Error ? err.message : String(err), true));
  }
}

async function listFiles(folders: Folder[], a: Record<string, unknown>) {
  if (typeof a.path !== "string" || !a.path.trim()) return text(folders.length ? folders.map((f) => `${f.name}\t${f.path}`).join("\n") : "No folders are open.");
  const root = resolveInFolders(folders, a.path);
  const depth = Math.min(4, Math.max(1, Number(a.depth) || 1));
  const lines: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
    for (const e of entries) {
      if (lines.length >= MAX_LIST) return;
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) {
        lines.push(`${"  ".repeat(level)}${e.name}/  (skipped)`);
        continue;
      }
      lines.push(`${"  ".repeat(level)}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory() && level + 1 < depth) await walk(join(dir, e.name), level + 1);
    }
  };
  await walk(root, 0);
  return text(lines.join("\n") + (lines.length >= MAX_LIST ? `\n… (stopped at ${MAX_LIST} entries)` : ""));
}

async function readFileTool(folders: Folder[], a: Record<string, unknown>) {
  const file = resolveInFolders(folders, a.path);
  const info = await stat(file);
  if (info.isDirectory()) return text("That is a directory — use list_files.", true);
  if (info.size > MAX_READ_BYTES * 5) return text(`File is ${Math.ceil(info.size / 1024)} KB — too large to read; search it instead.`, true);
  const buf = await readFile(file);
  if (buf.subarray(0, 8000).includes(0)) return text("This is a binary file.", true);
  const lines = buf.toString("utf8").split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const start = Math.max(1, Number(a.start_line) || 1);
  const end = Math.min(lines.length, Number(a.end_line) || start + MAX_LINES - 1, start + MAX_LINES - 1);
  let out = "";
  for (let i = start; i <= end; i++) {
    out += `${i}\t${lines[i - 1]}\n`;
    if (out.length > MAX_READ_BYTES) {
      out += `… (cut at line ${i}; ask for a later range)\n`;
      break;
    }
  }
  if (end < lines.length && !out.includes("… (cut")) out += `… (${lines.length - end} more lines; file has ${lines.length})\n`;
  return text(out || "(empty file)");
}

/** `*.ts` / `Program.cs` → a file-name test. */
function globTest(glob: string): (name: string) => boolean {
  const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return (name) => re.test(name);
}

async function searchFiles(folders: Folder[], a: Record<string, unknown>) {
  let re: RegExp;
  try {
    re = new RegExp(String(a.pattern ?? ""), "i");
  } catch (err) {
    return text(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  const roots = typeof a.path === "string" && a.path.trim() ? [resolveInFolders(folders, a.path)] : folders.map((f) => resolve(f.path));
  const nameOk = typeof a.glob === "string" && a.glob.trim() ? globTest(a.glob.trim()) : () => true;
  const hits: string[] = [];
  let scanned = 0;
  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= MAX_MATCHES || scanned >= MAX_FILE_SCAN) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= MAX_MATCHES || scanned >= MAX_FILE_SCAN) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile() && nameOk(e.name)) {
        scanned++;
        try {
          const info = await stat(full);
          if (info.size > 1_000_000) continue;
          const buf = await readFile(full);
          if (buf.subarray(0, 4000).includes(0)) continue;
          const lines = buf.toString("utf8").split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
            if (re.test(lines[i]!)) hits.push(`${full}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          }
        } catch {
          /* unreadable file: skip */
        }
      }
    }
  };
  for (const r of roots) await walk(r);
  const note = hits.length >= MAX_MATCHES ? `\n… (stopped at ${MAX_MATCHES} matches)` : scanned >= MAX_FILE_SCAN ? `\n… (stopped after ${MAX_FILE_SCAN} files)` : "";
  return text(hits.length ? hits.join("\n") + note : "No matches.");
}

const clip = (s: string, n = 1200) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

async function editFile(folders: Folder[], a: Record<string, unknown>, call: ToolCall, host: ToolHost) {
  const file = resolveInFolders(folders, a.path);
  const oldText = typeof a.old_text === "string" ? a.old_text : "";
  const newText = typeof a.new_text === "string" ? a.new_text : "";
  if (!oldText) return text("old_text is required.", true);
  const original = await readFile(file, "utf8");
  const crlf = original.includes("\r\n");
  const body = original.replace(/\r\n/g, "\n");
  const needle = oldText.replace(/\r\n/g, "\n");
  const first = body.indexOf(needle);
  if (first === -1) return text("old_text was not found in the file. Read the file again and copy the text exactly.", true);
  if (body.indexOf(needle, first + 1) !== -1) return text("old_text occurs more than once. Include more surrounding lines so it is unique.", true);
  if (!(await host.approve(call, `Edit ${file}\n\n--- remove\n${clip(needle)}\n\n+++ add\n${clip(newText.replace(/\r\n/g, "\n"))}`))) return text("The user declined this edit.", true);
  const next = body.slice(0, first) + newText.replace(/\r\n/g, "\n") + body.slice(first + needle.length);
  await writeFile(file, crlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
  return text(`Edited ${file}.`);
}

async function writeFileTool(folders: Folder[], a: Record<string, unknown>, call: ToolCall, host: ToolHost) {
  const file = resolveInFolders(folders, a.path);
  const content = typeof a.content === "string" ? a.content : "";
  let exists = true;
  try {
    await stat(file);
  } catch {
    exists = false;
  }
  if (!(await host.approve(call, `${exists ? "Overwrite" : "Create"} ${file} (${content.length} characters)\n\n${clip(content, 1800)}`))) return text("The user declined this write.", true);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return text(`${exists ? "Overwrote" : "Created"} ${file}.`);
}
