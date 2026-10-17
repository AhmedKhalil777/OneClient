import { readdir } from "node:fs/promises";
import type { ExplorerProvider, TreeNode } from "@oneclient/plugin-api";
import { joinRel, requireRoot, resolveInRoot } from "./roots.js";

/** Same idea as VS Code's default `files.exclude`. */
const HIDDEN = new Set([".git", ".svn", ".hg", ".DS_Store", "Thumbs.db"]);

const ICON = {
  folder: "icons/folder.svg",
  file: "icons/file.svg",
};

interface EntryData {
  /** Root-relative, "/"-separated; "" is the root itself. */
  path: string;
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

      return [...dirs.map((d) => directoryNode(joinRel(dirRel, d.name))), ...files.map((f) => fileNode(joinRel(dirRel, f.name)))];
    },
  };
}

function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}

export function directoryNode(path: string): TreeNode {
  return {
    id: path,
    label: baseName(path),
    nodeType: "files.directory",
    collapsible: "collapsed",
    icon: ICON.folder,
    contextValue: "files.directory",
    data: { path } satisfies EntryData,
  };
}

/** Clicking a file opens it in the editor view — one tab per file. */
export function fileNode(path: string): TreeNode {
  const name = baseName(path);
  return {
    id: path,
    label: name,
    nodeType: "files.file",
    collapsible: "none",
    icon: ICON.file,
    contextValue: "files.file",
    data: { path } satisfies EntryData,
    openView: { viewId: "files.editor", title: name, params: { path } },
  };
}
