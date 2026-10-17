import { readdir } from "node:fs/promises";
import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import { joinRel, requireRoot, resolveInRoot } from "./roots.js";

/** Same idea as VS Code's default `files.exclude`. */
const HIDDEN = new Set([".git", ".svn", ".hg", ".DS_Store", "Thumbs.db"]);

/** Registry icons (core's built-in set) — they follow the user's icon theme. */
const ICON = {
  folder: "$(folder)",
  file: "$(file)",
};

interface EntryData {
  /** Root-relative, "/"-separated; "" is the root itself. */
  path: string;
  /** Absolute path on disk — lets other plugins act on it (e.g. Terminal's "Open in Terminal"). */
  fsPath: string;
}

/**
 * Lists one directory per expand — nothing is walked ahead of time, so
 * opening a huge folder (or one with node_modules) stays instant. Folders
 * first, then files, each sorted case-insensitively like VS Code.
 */
export function createExplorerProvider(): ExplorerProvider {
  return {
    nodeTypes: ["files.directory", "files.file"],

    async getChildren(node, ctx): Promise<TreeNode[]> {
      const root = requireRoot(ctx.connectionId);
      const dirRel = node ? (node.data as EntryData).path : "";
      if (node && node.nodeType !== "files.directory") return [];

      const entries = await readdir(resolveInRoot(root, dirRel), { withFileTypes: true });
      const visible = entries.filter((e) => !HIDDEN.has(e.name));
      const byName = (a: { name: string }, b: { name: string }) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

      const dirs = visible.filter((e) => e.isDirectory()).sort(byName);
      const files = visible.filter((e) => !e.isDirectory()).sort(byName);

      return [...dirs.map((d) => directoryNode(root, joinRel(dirRel, d.name))), ...files.map((f) => fileNode(root, joinRel(dirRel, f.name)))];
    },
  };
}

function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}

export function directoryNode(root: string, path: string): TreeNode {
  return {
    id: path,
    label: baseName(path),
    nodeType: "files.directory",
    collapsible: "collapsed",
    icon: ICON.folder,
    contextValue: "files.directory",
    // Icon comes from the active icon theme's folder-name mappings; ICON.folder is the fallback.
    resource: { name: baseName(path), kind: "folder" },
    data: { path, fsPath: resolveInRoot(root, path) } satisfies EntryData,
  };
}

/** Clicking a file opens it in the editor view — one tab per file. */
export function fileNode(root: string, path: string): TreeNode {
  const name = baseName(path);
  return {
    id: path,
    label: name,
    nodeType: "files.file",
    collapsible: "none",
    icon: ICON.file,
    contextValue: "files.file",
    // Icon comes from the active icon theme's file name/extension mappings; ICON.file is the fallback.
    resource: { name, kind: "file" },
    data: { path, fsPath: resolveInRoot(root, path) } satisfies EntryData,
    openView: { viewId: "files.editor", title: name, params: { path } },
  };
}
