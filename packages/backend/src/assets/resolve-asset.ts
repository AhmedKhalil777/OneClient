import { resolve, sep } from "node:path";
import type { PluginManager } from "../plugins/plugin-manager.js";

/** Reserved asset host: the icon registry. Plugin ids can't contain dots, so this can't shadow a plugin. */
export const ICON_HOST = "oneclient.icons";

export type AssetLookup = { file: string; contentType?: string } | { status: 403 | 404 };

/**
 * The file behind an asset URL — `<host>/<path>` of `oneclient-asset://<host>/<path>` (desktop) or
 * `/asset/<host>/<path>` (web server):
 *  - `oneclient.icons/<id>.svg` → that icon id from the active icon theme;
 *  - `<pluginId>/<relative path>` → a file inside that plugin's install directory, never outside it.
 * Shared by both runtimes so they serve exactly the same files.
 */
export function resolveAsset(host: string, path: string, pluginManager: PluginManager, resolveIcon: (id: string) => string | undefined): AssetLookup {
  if (host === ICON_HOST) {
    const id = decodeURIComponent(path.replace(/^\/+/, "")).replace(/\.svg$/, "");
    const file = resolveIcon(id);
    return file ? { file, contentType: "image/svg+xml" } : { status: 404 };
  }
  const record = pluginManager.getRecord(host);
  const relativePath = decodeURIComponent(path.replace(/^\/+/, ""));
  if (!record || !relativePath) return { status: 404 };
  const root = resolve(record.rootDir);
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) return { status: 403 }; // path traversal guard
  return { file: resolved };
}
