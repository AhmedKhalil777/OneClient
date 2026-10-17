import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import type { PluginManager } from "../plugins/plugin-manager.js";

const ICON_HOST = "oneclient.icons";

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
 * PluginManager exists, from the main process.
 */
export function registerPluginAssetProtocolHandler(
  pluginManager: PluginManager,
  resolveIcon: (id: string) => string | undefined,
): void {
  protocol.handle("oneclient-asset", async (request) => {
    const url = new URL(request.url);

    // Reserved host: the icon registry — `oneclient-asset://oneclient.icons/<id>.svg` serves that id
    // from the active icon theme. Plugin ids can't contain dots, so this can't shadow a plugin.
    if (url.hostname === ICON_HOST) {
      const id = decodeURIComponent(url.pathname.replace(/^\/+/, "")).replace(/\.svg$/, "");
      const file = resolveIcon(id);
      if (!file) return new Response("Unknown icon", { status: 404 });
      try {
        const response = await net.fetch(pathToFileURL(file).href);
        return new Response(response.body, { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=31536000" } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }

    const pluginId = url.hostname;
    const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const record = pluginManager.getRecord(pluginId);
    if (!record || !relativePath) {
      return new Response("Not found", { status: 404 });
    }

    const root = resolve(record.rootDir);
    const resolved = resolve(root, relativePath);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      return new Response("Forbidden", { status: 403 }); // path traversal guard
    }

    try {
      return await net.fetch(pathToFileURL(resolved).href);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}
