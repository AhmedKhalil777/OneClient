import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { SearchResult, TreeNode } from "@oneclient/plugin-api";
import type { ConfigStore } from "../config/config-store.js";
import { EDITOR_VIEW, type EntryData, deleteEntry, listDirectory, newFile, newFolder, readTextFile, renameEntry, writeTextFile } from "./files.js";
import type { FindOptions, ReplaceOptions } from "./search.js";
import type { SearchWorker } from "./search-client.js";

/** A folder open in the Explorer. */
export interface WorkspaceFolder {
  id: string;
  name: string;
  /** Absolute path. */
  path: string;
}

/** Where a file opens: which folder holds it, and its "/"-separated path inside that folder. */
export interface FileLocation {
  folder: WorkspaceFolder;
  relPath: string;
}

/** "Show this line": sent by Search, delivered to whichever editor tab has that file. */
interface RevealRequest {
  path: string;
  line: number;
  col: number;
  length: number;
}

type PushToView = (viewId: string, folderId: string, message: unknown) => void;
type Args = Record<string, unknown> & { connectionId?: unknown };

/**
 * The workspace: the folders open in the Explorer, and everything core does with them — the tree, file operations,
 * the file editor's backend, and text search (on a worker thread). Plugins share it through `context.workspace`.
 *
 * Commands keep their `files.*` ids (the editor view, the Search sidebar and plugins call them); their
 * `connectionId` argument is the folder id, as every view and context-menu command receives it.
 */
export class WorkspaceService {
  private readonly listeners = new Set<(folders: WorkspaceFolder[]) => void>();
  private readonly pendingReveal = new Map<string, { at: number; reveal: RevealRequest }>();

  constructor(
    private readonly config: ConfigStore,
    private readonly search: SearchWorker,
    private readonly pushToView: PushToView,
  ) {}

  // ---- folders ------------------------------------------------------------------------------------------------

  folders(): WorkspaceFolder[] {
    return this.config.listFolders().map((f) => ({ ...f, path: resolve(f.path) }));
  }

  has(id: string): boolean {
    return this.config.listFolders().some((f) => f.id === id);
  }

  /** The absolute path of an open folder. */
  root(id: unknown): string {
    const folder = typeof id === "string" ? this.folders().find((f) => f.id === id) : undefined;
    if (!folder) throw new Error("That folder isn't open in the Explorer (any more).");
    return folder.path;
  }

  /** Opens a folder (or returns it if it's open already). */
  async addFolder(path: string, name?: string): Promise<WorkspaceFolder> {
    const absolute = resolve(path.trim());
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new Error(`Folder not found: ${absolute}`);
    if (!info.isDirectory()) throw new Error(`Not a folder: ${absolute}`);
    const existing = this.folders().find((f) => f.path.toLowerCase() === absolute.toLowerCase());
    if (existing) return existing;
    const folder = { id: randomUUID(), name: name?.trim() || basename(absolute) || absolute, path: absolute };
    this.config.addFolder(folder);
    this.changed();
    return folder;
  }

  removeFolder(id: string): void {
    this.config.removeFolder(id);
    this.search.dropCache();
    this.changed();
  }

  /** The innermost open folder containing `absolutePath`, or undefined when it's outside the workspace. */
  locate(absolutePath: string): FileLocation | undefined {
    const target = resolve(absolutePath);
    let best: FileLocation | undefined;
    for (const folder of this.folders()) {
      const rel = relative(folder.path, target);
      const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      if (inside && (!best || folder.path.length > best.folder.path.length)) best = { folder, relPath: rel.split(sep).join("/") };
    }
    return best;
  }

  private changed(): void {
    const folders = this.folders();
    for (const listener of this.listeners) listener(folders);
  }

  onChanged(listener: (folders: WorkspaceFolder[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- explorer tree --------------------------------------------------------------------------------------------

  children(folderId: string, node: TreeNode | null): Promise<TreeNode[]> {
    return listDirectory(this.root(folderId), node);
  }

  // ---- quick open (Ctrl+P) --------------------------------------------------------------------------------------

  /** File names matching `query` in every open folder; each hit carries its folder id. */
  async quickOpen(query: string, limit: number): Promise<Array<SearchResult & { folderId: string; folderName: string }>> {
    const perFolder = await Promise.all(
      this.folders().map(async (f) => (await this.search.quickOpen(f.id, f.path, query, limit).catch(() => [])).map((r) => ({ ...r, folderId: f.id, folderName: f.name }))),
    );
    return perFolder.flat().slice(0, limit);
  }

  // ---- editor <-> search ("reveal this match") -------------------------------------------------------------------

  /** An editor tab finished loading ("hello"): give it the reveal request that was waiting for it. */
  onEditorMessage(folderId: string | undefined, message: unknown): void {
    const msg = message as { type?: string; path?: string };
    if (msg?.type !== "hello" || typeof msg.path !== "string" || !folderId) return;
    const key = `${folderId}\u0000${msg.path}`;
    const waiting = this.pendingReveal.get(key);
    this.pendingReveal.delete(key);
    if (waiting && Date.now() - waiting.at < 15_000) this.pushToView(EDITOR_VIEW, folderId, { type: "reveal", ...waiting.reveal });
  }

  reveal(folderId: string, request: RevealRequest): void {
    this.pendingReveal.set(`${folderId}\u0000${request.path}`, { at: Date.now(), reveal: request });
    // Every editor tab of the folder receives it; the one showing `path` reacts.
    this.pushToView(EDITOR_VIEW, folderId, { type: "reveal", ...request });
  }

  // ---- commands (files.*) -----------------------------------------------------------------------------------------

  /** Core's file commands, by id. `args[0].connectionId` is the folder id. */
  commands(): Record<string, (args: Args) => Promise<unknown>> {
    const root = (a: Args) => this.root(a.connectionId);
    const path = (a: Args) => (typeof a.path === "string" ? a.path : "");
    const search = async <T extends object>(fn: () => Promise<T>) => {
      try {
        return { ok: true as const, ...(await fn()) };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    };
    return {
      "files.readFile": async (a) => readTextFile(root(a), path(a)),
      "files.writeFile": async (a) => writeTextFile(root(a), path(a), a.content),
      "files.newFile": async (a) => newFile(root(a), path(a), a.name),
      "files.newFolder": async (a) => newFolder(root(a), path(a), a.name),
      "files.rename": async (a) => renameEntry(root(a), path(a), a.newName),
      "files.delete": async (a) => deleteEntry(root(a), path(a)),
      "files.find": async (a) => search(() => this.search.find(root(a), a as unknown as FindOptions)),
      "files.replace": async (a) => {
        const r = await search(() => this.search.replace(root(a), a as unknown as ReplaceOptions));
        this.search.dropCache();
        return r;
      },
      "files.reveal": async (a) => {
        this.reveal(String(a.connectionId), { path: path(a), line: Number(a.line) || 1, col: Number(a.col) || 1, length: Number(a.length) || 0 });
        return { ok: true };
      },
    };
  }

  /** The data a file / folder node carries (for context-menu commands). */
  static entry(node: TreeNode | undefined): EntryData | undefined {
    return node?.data as EntryData | undefined;
  }
}
