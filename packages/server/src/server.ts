import { readdir, stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { createBackend } from "@oneclient/backend/backend.js";
import { resolveAsset } from "@oneclient/backend/assets/resolve-asset.js";
import { acquireInstanceLock } from "@oneclient/backend/config/instance-lock.js";
import { oneclientHome } from "@oneclient/backend/config/config-store.js";
import { KeyFileCipher, forkNode } from "@oneclient/backend/platform/node-platform.js";
import type { Platform } from "@oneclient/backend/platform/platform.js";
import { ASSET_PREFIX, PLUGIN_UI_PREFIX, VIEW_BRIDGE_PATH, WS_PATH } from "@oneclient/backend/shared/web-protocol.js";
import { Auth } from "./auth.js";
import { RemoteViewHost } from "./remote-view-host.js";
import { VIEW_BRIDGE_SCRIPT, safeJoin, sendFile } from "./static.js";
import { WsRpc } from "./ws-rpc.js";

export interface ServerOptions {
  host: string;
  port: number;
  token: string;
  /** The workbench UI build (packages/workbench/dist). */
  workbenchDir: string;
  pluginDirs: string[];
  version: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * The self-hosted web runtime: oneClient's backend on plain Node (no Electron) behind an HTTP + WebSocket server,
 * used from a browser. One user — whoever holds the token.
 */
export async function startServer(opts: ServerOptions) {
  const rpc = new WsRpc();
  const platform: Platform = {
    runtime: "web",
    fork: forkNode,
    cipher: undefined as unknown as Platform["cipher"], // set below, once the config folder is known
    secretsFile: "secrets-server.json",
    pluginDirs: opts.pluginDirs,
    appVersion: opts.version,
    versions: { electron: "", chrome: "", node: process.versions.node, v8: process.versions.v8 },
  };
  const configDir = oneclientHome();
  const releaseLock = acquireInstanceLock(configDir, "web");
  (platform as { cipher: Platform["cipher"] }).cipher = new KeyFileCipher(join(configDir, "server.key"));

  const backend = await createBackend({
    platform,
    rpc,
    createViews: (onMessageFromView) => new RemoteViewHost(rpc, onMessageFromView),
  });
  registerServerHandlers(rpc);

  const loopback = LOOPBACK.has(opts.host);
  const allowedHosts = loopback ? new Set(["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${opts.port}`)) : null;
  const auth = new Auth(opts.token, allowedHosts);

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error("[web]", err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal error");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "SAMEORIGIN");
    if (!auth.hostAllowed(req)) return void res.writeHead(421, { "content-type": "text/plain" }).end("Misdirected request");
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
    const url = new URL(req.url ?? "/", "http://local");

    // The printed link: swap the token for a cookie and drop it from the address bar.
    const token = url.searchParams.get("token");
    if (token !== null) {
      if (!auth.tokenMatches(token)) return void unauthorized(res);
      url.searchParams.delete("token");
      const secure = String(req.headers["x-forwarded-proto"] ?? "") === "https";
      res.writeHead(302, { "set-cookie": auth.setCookie(secure), location: `${url.pathname}${url.search}` });
      return void res.end();
    }
    if (!auth.hasCookie(req)) return void unauthorized(res);

    const path = url.pathname;
    if (path === VIEW_BRIDGE_PATH) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return void res.end(VIEW_BRIDGE_SCRIPT);
    }
    if (path.startsWith(ASSET_PREFIX)) {
      const [host = "", ...rest] = path.slice(ASSET_PREFIX.length).split("/");
      const found = resolveAsset(decodeURIComponent(host), rest.join("/"), backend.pluginManager, (id) => backend.themes.resolveIconFile(id));
      if ("status" in found) return void res.writeHead(found.status).end();
      if (!(await sendFile(res, found.file))) res.writeHead(404).end();
      return;
    }
    if (path.startsWith(PLUGIN_UI_PREFIX)) {
      const [pluginId = "", ...rest] = path.slice(PLUGIN_UI_PREFIX.length).split("/");
      const record = backend.pluginManager.getRecord(decodeURIComponent(pluginId));
      const ui = record?.manifest.ui ? join(record.rootDir, record.manifest.ui) : undefined;
      const file = ui ? safeJoin(ui, rest.join("/")) : undefined;
      if (!file || !(await sendFile(res, file, { injectViewBridge: true }))) res.writeHead(404).end();
      return;
    }
    // The workbench: the shell at /, core views under /views/, Vite's hashed bundles under /assets/.
    const file = safeJoin(opts.workbenchDir, path === "/" ? "index.html" : path);
    const isView = path.startsWith("/views/");
    if (!file || !(await sendFile(res, file, { injectViewBridge: isView, cache: path.startsWith("/assets/") }))) res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://local").pathname;
    if (path !== WS_PATH || !auth.hostAllowed(req) || !auth.hasCookie(req) || !auth.sameOrigin(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return void socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => rpc.attach(ws));
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolveListen());
  });

  const shownHost = opts.host === "0.0.0.0" || opts.host === "::" ? "localhost" : opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return {
    url: `http://${shownHost}:${opts.port}/`,
    loginUrl: `http://${shownHost}:${opts.port}/?token=${encodeURIComponent(opts.token)}`,
    configDir: dirname(backend.config.filePath),
    async close(): Promise<void> {
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
      await backend.dispose();
      releaseLock();
    },
  };
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>oneClient</title>
<body style="font:15px system-ui;background:#1e1e1e;color:#ccc;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:440px"><h2 style="color:#fff">oneClient</h2>
<p>Open the link the oneClient server printed when it started — it carries the access token.</p>
<p style="color:#888">Lost it? Run the server again; it prints the link every time.</p></div>`);
}

/** Web-only calls: browsing the server's folders for "Open Folder…" (the desktop uses a native dialog). */
function registerServerHandlers(rpc: WsRpc): void {
  rpc.handle("oneclient-web:list-dirs", async (_caller, requested: unknown) => {
    const dir = resolve(typeof requested === "string" && requested.trim() ? requested : homedir());
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => ({ name: e.name, path: join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const parent = dirname(dir) !== dir ? dirname(dir) : null;
    let roots: string[] = [];
    if (process.platform === "win32") {
      const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
      const found = await Promise.all(letters.map((l) => stat(`${l}:\\`).then(() => `${l}:\\`, () => null)));
      roots = found.filter((r): r is string => r !== null);
    } else roots = ["/"];
    return { path: dir, parent, dirs, roots, home: homedir(), separator: process.platform === "win32" ? "\\" : "/" };
  });
}
