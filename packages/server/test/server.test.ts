import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { IpcChannel } from "@oneclient/backend/shared/ipc-contract.js";
import { KeyFileCipher } from "@oneclient/backend/platform/node-platform.js";
import { startServer } from "../src/server.js";
import { safeJoin } from "../src/static.js";
import { RemoteViewHost } from "../src/remote-view-host.js";
import type { WebClient, WsRpc } from "../src/ws-rpc.js";

const TOKEN = "test-token-123";
let home: string;
let server: Awaited<ReturnType<typeof startServer>>;
let base: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "oc-server-test-"));
  process.env.ONECLIENT_HOME = home;
  const ui = join(home, "ui");
  mkdirSync(join(ui, "views", "editor"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<!doctype html><html><head><title>oneClient</title></head><body>shell</body></html>");
  writeFileSync(join(ui, "views", "editor", "index.html"), "<!doctype html><html><head><title>editor</title></head><body></body></html>");
  writeFileSync(join(home, "secret.txt"), "do not serve");
  server = await startServer({ host: "127.0.0.1", port: 0, token: TOKEN, workbenchDir: ui, pluginDirs: [], version: "0.0.0-test" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true });
});

async function login(): Promise<string> {
  const res = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

describe("access", () => {
  it("refuses requests without the token", async () => {
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/?token=wrong`, { redirect: "manual" })).status).toBe(401);
  });

  it("swaps the token for a strict, HttpOnly cookie and drops it from the URL", async () => {
    const res = await fetch(`${base}/views/editor/index.html?x=1&token=${TOKEN}`, { redirect: "manual" });
    expect(res.headers.get("location")).toBe("/views/editor/index.html?x=1");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it("serves the shell and injects the view bridge into views only", async () => {
    const cookie = await login();
    const shell = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(shell).toContain("shell");
    expect(shell).not.toContain("/__oneclient/view.js");
    const view = await (await fetch(`${base}/views/editor/index.html`, { headers: { cookie } })).text();
    expect(view).toMatch(/<head><script src="\/__oneclient\/view.js"><\/script>/);
  });

  it("never serves files outside the UI folder", async () => {
    const cookie = await login();
    // fetch() normalises "..", so encode it the way an attacker would.
    const res = await fetch(`${base}/%2e%2e/secret.txt`, { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(safeJoin(join(home, "ui"), "../secret.txt")).toBeUndefined();
    expect(safeJoin(join(home, "ui"), "%2e%2e%2fsecret.txt")).toBeUndefined();
    expect(safeJoin(join(home, "ui"), "views/editor/index.html")).toBe(join(home, "ui", "views", "editor", "index.html"));
  });
});

function socket(cookie: string | undefined, origin: string | undefined): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/__oneclient/ws`, { headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

describe("WebSocket RPC", () => {
  it("refuses sockets without the cookie or from another origin", async () => {
    const cookie = await login();
    await expect(socket(undefined, base)).rejects.toThrow(/401/);
    await expect(socket(cookie, "http://evil.example")).rejects.toThrow(/401/);
  });

  it("answers calls with the backend's handlers", async () => {
    const ws = await socket(await login(), base);
    const call = (ch: string, ...args: unknown[]) =>
      new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
        const id = Math.floor(Math.random() * 1e9);
        ws.on("message", function onMessage(data) {
          const msg = JSON.parse(String(data));
          if (msg.t === "result" && msg.id === id) {
            ws.off("message", onMessage);
            resolve(msg);
          }
        });
        ws.send(JSON.stringify({ t: "call", id, ch, args }));
      });
    const info = await call(IpcChannel.AppInfo);
    expect(info.ok).toBe(true);
    expect(info.value).toMatchObject({ runtime: "web", electron: "", version: "0.0.0-test" });
    expect((await call(IpcChannel.ConnectionList)).value).toEqual([]);
    const unknown = await call("no-such-channel");
    expect(unknown).toMatchObject({ ok: false, error: 'No handler for "no-such-channel".' });
    ws.close();
  });
});

describe("secrets", () => {
  it("encrypts with the key file and can't be read with another key", () => {
    const a = new KeyFileCipher(join(home, "a.key"));
    const b = new KeyFileCipher(join(home, "b.key"));
    const ciphertext = a.encrypt("p@ss");
    expect(ciphertext).not.toContain("p@ss");
    expect(a.decrypt(ciphertext)).toBe("p@ss");
    expect(new KeyFileCipher(join(home, "a.key")).decrypt(ciphertext)).toBe("p@ss"); // the key file persists
    expect(() => b.decrypt(ciphertext)).toThrow();
    expect(readFileSync(join(home, "a.key"), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("remote views", () => {
  /** A fake WsRpc: just enough for the view host. */
  function setup() {
    const sent: Array<{ client: string; msg: unknown }> = [];
    let viewEvent: (client: WebClient, inst: string, kind: string, payload: unknown) => void = () => {};
    const rpc = { setViewEventHandler: (h: typeof viewEvent) => (viewEvent = h), onDisconnect: () => {}, handle: () => {} } as unknown as WsRpc;
    const client = (id: string) => ({ id, send: (msg: unknown) => sent.push({ client: id, msg }) }) as unknown as WebClient;
    const posted: unknown[] = [];
    const host = new RemoteViewHost(rpc, (pluginId, viewId, connectionId, message) => posted.push({ pluginId, viewId, connectionId, message }));
    return { host, client, sent, posted, fromView: (c: WebClient, inst: string, kind: string, payload: unknown) => viewEvent(c, inst, kind, payload) };
  }

  it("routes pushes to every tab showing the view, even when a missing connection arrived as null", () => {
    const { host, client, sent } = setup();
    const a = client("a");
    const b = client("b");
    // JSON turns undefined into null; pushes for connection-less views (the terminal) must still match.
    host.open({ instanceId: "t", pluginId: "core", viewId: "terminal.panel", connectionId: null as unknown as undefined, corePage: "views/terminal/index.html" }, a);
    host.open({ instanceId: "t", pluginId: "core", viewId: "terminal.panel", corePage: "views/terminal/index.html" }, b);
    host.push("terminal.panel", undefined, { hello: 1 });
    expect(sent.map((s) => s.client)).toEqual(["a", "b"]);
  });

  it("builds plugin view URLs with the connection set last, and ignores events from tabs that don't own the view", () => {
    const { host, client, posted, fromView } = setup();
    const a = client("a");
    const { url } = host.open({ instanceId: "v1", pluginId: "oneclient-postgres", viewId: "q", connectionId: "c1", params: { connectionId: "spoofed", db: "shop" }, entryDir: "/p/ui", entryFile: "index.html" }, a);
    const parsed = new URL(url, "http://x");
    expect(parsed.pathname).toBe("/plugin-ui/oneclient-postgres/index.html");
    // A plugin-supplied connectionId param is overwritten by the instance's real connection.
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ db: "shop", connectionId: "c1" });
    fromView(client("b"), "v1", "post", "from another tab");
    fromView(a, "v1", "post", "hello");
    expect(posted).toEqual([{ pluginId: "oneclient-postgres", viewId: "q", connectionId: "c1", message: "hello" }]);
  });
});
