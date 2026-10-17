import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchResult } from "@oneclient/plugin-api";
import { resolveInRoot } from "./roots.js";

/** Directories nobody wants hits from (VS Code's default `search.exclude`, roughly). */
const SKIP_DIRS = new Set([".git", ".svn", ".hg", "node_modules", "dist", "out", "bin", "obj", ".vs", ".idea", "__pycache__", ".next", ".nuxt", "coverage", ".turbo", ".cache", "target", ".gradle"]);
const MAX_FILES_WALKED = 60_000;
const WALK_BUDGET_MS = 6000;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

export interface WalkedFile {
  /** Root-relative, "/"-separated. */
  path: string;
  name: string;
}

export interface WalkResult {
  files: WalkedFile[];
  /** The walk hit the file or time limit. */
  truncated: boolean;
}

/** Lists every file under `root`, skipping the usual build/vendor directories. Breadth-first, so shallow files come first. */
export async function walk(root: string, extraSkip: (relPath: string) => boolean = () => false): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  const queue: string[] = [""];
  const started = Date.now();
  let truncated = false;
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir ? join(root, ...dir.split("/")) : root, { withFileTypes: true });
    } catch {
      continue; // unreadable (permissions, vanished) — skip it
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !extraSkip(rel)) queue.push(rel);
      } else if (e.isFile()) {
        files.push({ path: rel, name: e.name });
      }
    }
    if (files.length >= MAX_FILES_WALKED || Date.now() - started > WALK_BUDGET_MS) {
      truncated = queue.length > 0;
      break;
    }
  }
  return { files, truncated };
}

// ---- quick-open (global search provider) -------------------------------------------------------------------------

const cache = new Map<string, { at: number; files: WalkedFile[] }>();
const CACHE_MS = 20_000;

/** Typing in the top bar searches on every keystroke, so remember the file list for a few seconds. */
async function filesOf(connectionId: string, root: string): Promise<WalkedFile[]> {
  const hit = cache.get(connectionId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
  const { files } = await walk(root);
  cache.set(connectionId, { at: Date.now(), files });
  return files;
}

export const dropSearchCache = (): void => cache.clear();

/** First letters of the words in a file name: "plugin-manager.ts" → p m t; "GetCustomer.cs" → g c c. */
function wordStarts(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    const prev = name[i - 1];
    const boundary = i === 0 || /[-_. ]/.test(prev ?? "") || (/[A-Z]/.test(c) && /[a-z0-9]/.test(prev ?? ""));
    if (boundary && /[A-Za-z0-9]/.test(c)) out.push(c.toLowerCase());
  }
  return out;
}

/** Higher is better; 0 = no match. File name matches beat path matches; contiguous beats scattered. */
export function scoreName(query: string, name: string, path: string): number {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 800 - Math.min(100, n.length - q.length);
  const at = n.indexOf(q);
  if (at >= 0) return 600 - Math.min(100, at * 5) - Math.min(50, n.length - q.length);
  // Initials ("pm" → plugin-manager.ts, "gc" → GetCustomer.cs): each letter starts a word of the name.
  if (q.length >= 2 && q.length <= 5) {
    const initials = wordStarts(name);
    let at = 0;
    let ok = true;
    for (const ch of q) {
      const f = initials.findIndex((w, i) => i >= at && w === ch);
      if (f < 0) {
        ok = false;
        break;
      }
      at = f + 1;
    }
    if (ok) return 350 - Math.min(100, initials.length * 5);
  }
  // Several words ("plugin man"): every word appears in the path.
  const words = q.split(/[\s\-_./]+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => path.toLowerCase().includes(w))) return 200;
  const p = path.toLowerCase();
  if (q.length >= 2 && p.includes(q)) return 150;
  return 0;
}

export async function quickOpen(connectionId: string, root: string, query: string, limit: number): Promise<SearchResult[]> {
  const files = await filesOf(connectionId, root);
  const scored: Array<{ f: WalkedFile; s: number }> = [];
  for (const f of files) {
    const s = scoreName(query.trim(), f.name, f.path);
    if (s > 0) scored.push({ f, s });
  }
  scored.sort((a, b) => b.s - a.s || a.f.path.length - b.f.path.length || a.f.path.localeCompare(b.f.path));
  return scored.slice(0, limit).map(({ f }) => {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    return {
      id: f.path,
      label: f.name,
      ...(dir ? { description: dir } : {}),
      icon: "$(file)",
      resource: { name: f.name, kind: "file" as const },
      openView: { viewId: "files.editor", title: f.name, params: { path: f.path } },
    };
  });
}

// ---- find / replace in files -----------------------------------------------------------------------------------------

export interface FindOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Comma-separated globs ("src, **\/*.ts"); empty = everything. */
  include?: string;
  exclude?: string;
  maxResults?: number;
}

export interface LineMatch {
  line: number; // 1-based
  col: number; // 1-based
  length: number;
  /** The whole line (trimmed to a sane length), so the UI can show context around the hit. */
  text: string;
  /** Offset of `text` inside the real line when it was cut. */
  textOffset: number;
}

export interface FileMatches {
  path: string;
  matches: LineMatch[];
}

export interface FindResult {
  files: FileMatches[];
  totalMatches: number;
  filesSearched: number;
  /** Stopped early (too many matches, or a huge folder). */
  truncated: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildRegExp(o: FindOptions): RegExp {
  if (!o.query) throw new Error("Type something to search for.");
  let source = o.regex ? o.query : escapeRegExp(o.query);
  if (o.wholeWord) source = `(?<![\\w])(?:${source})(?![\\w])`;
  try {
    return new RegExp(source, `g${o.caseSensitive ? "" : "i"}m`);
  } catch (err) {
    throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One glob → RegExp. `*` stays inside a path segment, `**` crosses them, `?` is one character, `{a,b}` alternates. */
function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!g) return /$^/;
  // A bare name or folder ("src", "*.ts", "docs/api") matches anywhere, and everything below a matching folder.
  const hasSlashOrStarStar = g.includes("/") ;
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end > i) {
        out += `(?:${g
          .slice(i + 1, end)
          .split(",")
          .map((alt) => alt.trim().replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = end;
      } else out += "\\{";
    } else out += c.replace(/[.+^$()|[\]\\}]/g, "\\$&");
  }
  const anchored = hasSlashOrStarStar && !g.startsWith("**") ? `^${out}` : `(?:^|/)${out}`;
  return new RegExp(`${anchored}(?:/.*)?$`, "i");
}

/** Splits "src, *.{ts,tsx}" on commas that are not inside braces. */
function splitGlobs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of text) {
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function buildGlobFilter(include: string | undefined, exclude: string | undefined): (path: string) => boolean {
  const list = (s: string | undefined) => splitGlobs(s ?? "").map(globToRegExp);
  const inc = list(include);
  const exc = list(exclude);
  return (path) => (inc.length === 0 || inc.some((r) => r.test(path))) && !exc.some((r) => r.test(path));
}

const MAX_LINE_CHARS = 300;

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

async function readTextFile(absolute: string): Promise<{ text: string; bom: boolean } | null> {
  try {
    const info = await stat(absolute);
    if (info.size > MAX_SEARCH_FILE_BYTES) return null;
    const buf = await readFile(absolute);
    if (looksBinary(buf)) return null;
    const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    return { text: buf.toString("utf-8", bom ? 3 : 0), bom };
  } catch {
    return null;
  }
}

export async function findInFiles(root: string, o: FindOptions): Promise<FindResult> {
  const re = buildRegExp(o);
  const keep = buildGlobFilter(o.include, o.exclude);
  const maxResults = Math.min(5000, Math.max(1, o.maxResults ?? 2000));
  const { files, truncated: walkTruncated } = await walk(root);
  const result: FindResult = { files: [], totalMatches: 0, filesSearched: 0, truncated: walkTruncated };

  for (const f of files) {
    if (!keep(f.path)) continue;
    const content = await readTextFile(join(root, ...f.path.split("/")));
    if (!content) continue;
    result.filesSearched++;
    const matches: LineMatch[] = [];
    const lines = content.text.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li]!.replace(/\r$/, "");
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        if (m[0] === "") {
          re.lastIndex++;
          continue; // an empty match (e.g. "x*") isn't a hit
        }
        const cut = raw.length > MAX_LINE_CHARS ? Math.max(0, m.index - 80) : 0;
        matches.push({ line: li + 1, col: m.index + 1, length: m[0].length, text: raw.slice(cut, cut + MAX_LINE_CHARS), textOffset: cut });
        result.totalMatches++;
        if (result.totalMatches >= maxResults) break;
      }
      if (result.totalMatches >= maxResults) break;
    }
    if (matches.length) result.files.push({ path: f.path, matches });
    if (result.totalMatches >= maxResults) {
      result.truncated = true;
      break;
    }
  }
  return result;
}

export interface ReplaceOptions extends FindOptions {
  replacement: string;
  /** Only these files (root-relative); omit to replace in every file that matches. */
  paths?: string[];
}

/** `$1`-style references work in regex mode; in plain mode the replacement is literal. */
export async function replaceInFiles(root: string, o: ReplaceOptions): Promise<{ filesChanged: number; replacements: number; errors: string[] }> {
  const re = buildRegExp(o);
  const keep = buildGlobFilter(o.include, o.exclude);
  const only = o.paths ? new Set(o.paths) : null;
  const { files } = await walk(root);
  const out = { filesChanged: 0, replacements: 0, errors: [] as string[] };
  for (const f of files) {
    if (only ? !only.has(f.path) : !keep(f.path)) continue;
    const absolute = resolveInRoot(root, f.path);
    const content = await readTextFile(absolute);
    if (!content) continue;
    let count = 0;
    const next = content.text.replace(re, (...args) => {
      const match = args[0] as string;
      if (match === "") return match;
      count++;
      if (!o.regex) return o.replacement;
      // Expand $1, $&, $<name> like String.replace does.
      const groups = typeof args[args.length - 1] === "object" ? (args[args.length - 1] as Record<string, string>) : undefined;
      const captures = args.slice(1, groups ? -3 : -2) as string[];
      return o.replacement.replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (_m, tok: string, name?: string) => {
        if (tok === "$") return "$";
        if (tok === "&") return match;
        if (name) return groups?.[name] ?? "";
        const idx = Number(tok);
        return idx >= 1 && idx <= captures.length ? (captures[idx - 1] ?? "") : _m;
      });
    });
    if (count === 0 || next === content.text) continue;
    try {
      await writeFile(absolute, (content.bom ? "﻿" : "") + next, "utf-8");
      out.filesChanged++;
      out.replacements += count;
    } catch (err) {
      out.errors.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
