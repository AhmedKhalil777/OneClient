import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ConnectionProvider } from "@oneclient/plugin-api";
import { roots } from "./roots.js";

export interface FolderConfig {
  path?: string;
}

/** A "connection" here is just an opened folder; connecting checks it exists and remembers its path. */
export function createConnectionProvider(): ConnectionProvider<FolderConfig> {
  return {
    typeId: "folder",
    configSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", title: "Folder", format: "directory" },
      },
    },

    async connect(config, ctx) {
      const root = await requireDirectory(config.path);
      if (ctx.connectionId) roots.set(ctx.connectionId, root);
      return { id: ctx.connectionId ?? `folder-${Date.now()}`, typeId: "folder", state: {} };
    },

    async test(config) {
      try {
        const root = await requireDirectory(config.path);
        const entries = await readdir(root);
        return { success: true, message: `${root} — ${entries.length} item(s).` };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    async disconnect(_handle, ctx) {
      if (ctx.connectionId) roots.delete(ctx.connectionId);
    },
  };
}

async function requireDirectory(path: string | undefined): Promise<string> {
  if (!path?.trim()) throw new Error("Choose a folder.");
  const root = resolve(path.trim());
  let info;
  try {
    info = await stat(root);
  } catch {
    throw new Error(`Folder not found: ${root}`);
  }
  if (!info.isDirectory()) throw new Error(`Not a folder: ${root}`);
  return root;
}
