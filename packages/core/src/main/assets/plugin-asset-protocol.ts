import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import type { PluginManager } from "@oneclient/backend/plugins/plugin-manager.js";
import { resolveAsset } from "@oneclient/backend/assets/resolve-asset.js";

/**
 * Must run before `app.whenReady()` — Electron requires privileged scheme
 * registration to happen at module load time, before the app is ready.
 * `standard`+`secure` is what lets `<img src="oneclient-asset://...">`
 * load under the renderer's CSP once `img-src` allows the scheme (see
 * renderer/index.html).
 */
export function registerPluginAssetSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "oneclient-asset",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

/**
 * Serves read-only, static assets (icons, …) a plugin ships from inside
 * its own install directory — `oneclient-asset://<pluginId>/<relative-path>`.
 * This is the only way plugin-declared file paths (manifest `icon`,
 * contribution `icon` fields) ever reach the renderer; nothing in the
 * renderer is handed a real filesystem path. Call once, after the
 * PluginManager exists, from the main process. (The web server serves the
 * same files at `/asset/...` — see resolve-asset.ts.)
 */
export function registerPluginAssetProtocolHandler(
  pluginManager: PluginManager,
  resolveIcon: (id: string) => string | undefined,
): void {
  protocol.handle("oneclient-asset", async (request) => {
    const url = new URL(request.url);
    const found = resolveAsset(url.hostname, url.pathname, pluginManager, resolveIcon);
    if ("status" in found) return new Response(found.status === 403 ? "Forbidden" : "Not found", { status: found.status });
    try {
      const response = await net.fetch(pathToFileURL(found.file).href);
      if (!found.contentType) return response;
      return new Response(response.body, { headers: { "content-type": found.contentType, "cache-control": "max-age=31536000" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}
