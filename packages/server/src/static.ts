import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { VIEW_BRIDGE_PATH } from "@oneclient/backend/shared/web-protocol.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** `rel` inside `root`, or undefined when it would escape it (path traversal). */
export function safeJoin(root: string, rel: string): string | undefined {
  const base = resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return undefined;
  }
  const full = resolve(base, `.${sep}${decoded.replace(/^[/\\]+/, "")}`);
  return full === base || full.startsWith(base + sep) ? full : undefined;
}

const VIEW_BRIDGE_TAG = `<script src="${VIEW_BRIDGE_PATH}"></script>`;

/**
 * Sends a file. View pages (`injectViewBridge`) get the view bridge as the first thing in <head>, so
 * `window.oneclientView` exists before the view's own scripts run — what the desktop's view preload does.
 */
export async function sendFile(res: ServerResponse, file: string, opts: { injectViewBridge?: boolean; cache?: boolean } = {}): Promise<boolean> {
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return false;
    size = st.size;
  } catch {
    return false;
  }
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  // Vite's hashed assets never change; pages and everything else are revalidated.
  const cache = opts.cache ? "public, max-age=31536000, immutable" : "no-cache";
  if (opts.injectViewBridge && type.startsWith("text/html")) {
    const html = await readFile(file, "utf8");
    const injected = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${VIEW_BRIDGE_TAG}`) : `${VIEW_BRIDGE_TAG}${html}`;
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(injected);
    return true;
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "cache-control": cache });
  createReadStream(file).pipe(res);
  return true;
}

/**
 * Runs inside every view iframe (same origin as the shell): asks the shell's bridge for this window's
 * `window.oneclientView`, and points asset URLs at the server.
 */
export const VIEW_BRIDGE_SCRIPT = `(function () {
  window.__ONECLIENT_ASSET_BASE__ = location.origin + "/asset/";
  var host;
  try { host = window.parent !== window ? window.parent.__oneclientViewHost : undefined; } catch (e) { host = undefined; }
  if (host) window.oneclientView = host.attach(window);
  else console.warn("[oneClient] this view only works inside the oneClient workbench");
})();
`;
