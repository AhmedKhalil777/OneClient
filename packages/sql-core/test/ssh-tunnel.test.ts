import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, utils } from "ssh2";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SSH_AUTH_KEY, closeTunnel, openTunnel, sshEnabled, tunnelFor } from "../src/ssh/tunnel.js";

const pem = () => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
const userKey = pem();
const userPub = utils.parseKey(userKey.privateKey) as ReturnType<typeof utils.parseKey> & { getPublicSSH(): Buffer; type: string; verify(data: Buffer, sig: Buffer, algo?: string): boolean };

/** A tiny SSH server (password `pw` or the test key for user `dev`) that forwards channels to their requested host:port. */
async function sshServer(hostKey: string, port = 0) {
  let sessions = 0;
  const clients = new Set<{ end(): void }>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => undefined);
    client.on("authentication", (ctx) => {
      if (ctx.username !== "dev") return ctx.reject();
      if (ctx.method === "password" && ctx.password === "pw") return ctx.accept();
      if (ctx.method === "publickey" && ctx.key.algo === userPub.type && ctx.key.data.equals(userPub.getPublicSSH())) {
        return ctx.signature ? (userPub.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject()) : ctx.accept();
      }
      return ctx.reject(["password", "publickey"]);
    });
    client.on("ready", () => {
      sessions++;
      client.on("tcpip", (accept, _reject, info) => {
        const channel = accept();
        const upstream = net.connect(info.destPort, info.destIP);
        upstream.on("error", () => channel.close());
        channel.on("error", () => upstream.destroy());
        channel.pipe(upstream).pipe(channel);
      });
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    sessions: () => sessions,
    /** Drops every SSH connection, like a network blip. */
    drop: () => clients.forEach((c) => c.end()),
    close: () => new Promise<void>((r) => (clients.forEach((c) => c.end()), server.close(() => r()))),
  };
}

/** Echoes everything back, prefixed with the connection's own number so tests can tell sockets apart. */
async function echoServer() {
  const server = net.createServer((s) => s.on("data", (d) => s.write(d)).on("error", () => undefined));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const roundTrip = (port: number, text: string) =>
  new Promise<string>((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(text));
    s.once("data", (d) => (s.destroy(), resolve(d.toString())));
    s.once("error", reject);
    setTimeout(() => (s.destroy(), reject(new Error("timeout"))), 5000);
  });

describe("SSH tunnel", () => {
  let home: string;
  let echo: Awaited<ReturnType<typeof echoServer>>;
  const hostKey = pem().privateKey;
  const toClose: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "oc-ssh-"));
    process.env.ONECLIENT_HOME = home;
    echo = await echoServer();
  });
  afterEach(async () => {
    for (const c of toClose.splice(0)) await c();
  });
  afterAll(async () => {
    await echo.close();
    delete process.env.ONECLIENT_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const cfg = (ssh: { port: number }, over: Record<string, unknown> = {}) => ({ sshHost: "127.0.0.1", sshPort: ssh.port, sshUser: "dev", sshPassword: "pw", ...over });

  it("only turns on when an SSH host is set", () => {
    expect(sshEnabled({})).toBe(false);
    expect(sshEnabled({ sshHost: "  " })).toBe(false);
    expect(sshEnabled({ sshHost: "bastion" })).toBe(true);
  });

  it("forwards many sockets over one SSH connection", async () => {
    const ssh = await sshServer(hostKey);
    toClose.push(ssh.close);
    const t = await openTunnel(cfg(ssh), { host: "127.0.0.1", port: echo.port });
    toClose.push(() => t.close());
    expect(t.host).toBe("127.0.0.1");
    const answers = await Promise.all(Array.from({ length: 25 }, (_, i) => roundTrip(t.port, `hello-${i}`)));
    expect(answers).toEqual(Array.from({ length: 25 }, (_, i) => `hello-${i}`));
    expect(ssh.sessions()).toBe(1); // a pool of 25 sockets is one SSH login
  });

  it("signs in with a private key file", async () => {
    const ssh = await sshServer(hostKey);
    toClose.push(ssh.close);
    const keyFile = join(home, "id_test");
    await writeFile(keyFile, userKey.privateKey);
    const t = await openTunnel({ sshHost: "127.0.0.1", sshPort: ssh.port, sshUser: "dev", sshAuth: SSH_AUTH_KEY, sshKeyFile: keyFile }, { host: "127.0.0.1", port: echo.port });
    toClose.push(() => t.close());
    expect(await roundTrip(t.port, "via-key")).toBe("via-key");
  });

  it("explains what is wrong", async () => {
    const ssh = await sshServer(hostKey);
    toClose.push(ssh.close);
    const target = { host: "127.0.0.1", port: echo.port };
    await expect(openTunnel(cfg(ssh, { sshPassword: "nope" }), target)).rejects.toThrow(/refused the sign-in/);
    await expect(openTunnel(cfg(ssh, { sshUser: "" }), target)).rejects.toThrow(/enter the SSH user/);
    await expect(openTunnel(cfg(ssh, { sshAuth: SSH_AUTH_KEY, sshKeyFile: join(home, "missing") }), target)).rejects.toThrow(/doesn't exist/);
    await expect(openTunnel(cfg(ssh, { sshAuth: SSH_AUTH_KEY }), target)).rejects.toThrow(/choose a private key file/);
    const closed = await sshServer(hostKey);
    const port = closed.port;
    await closed.close();
    await expect(openTunnel(cfg({ port }), target)).rejects.toThrow(/can't reach/);
  });

  it("trusts a host key on first use and refuses a different one afterwards", async () => {
    const first = await sshServer(hostKey);
    const port = first.port;
    const t = await openTunnel(cfg(first), { host: "127.0.0.1", port: echo.port });
    await t.close();
    await first.close();
    const reinstalled = await sshServer(pem().privateKey, port); // same address, new key
    toClose.push(reinstalled.close);
    await expect(openTunnel(cfg({ port }), { host: "127.0.0.1", port: echo.port })).rejects.toThrow(/host key .* has changed/);
  });

  it("reconnects when the SSH connection drops", async () => {
    const ssh = await sshServer(hostKey);
    toClose.push(ssh.close);
    const t = await openTunnel(cfg(ssh), { host: "127.0.0.1", port: echo.port });
    toClose.push(() => t.close());
    expect(await roundTrip(t.port, "before")).toBe("before");
    ssh.drop();
    await new Promise((r) => setTimeout(r, 200));
    expect(await roundTrip(t.port, "after")).toBe("after");
    expect(ssh.sessions()).toBe(2);
  });

  it("keeps one tunnel per saved connection and closes it", async () => {
    const ssh = await sshServer(hostKey);
    toClose.push(ssh.close);
    expect(await tunnelFor("c1", {}, { host: "x", port: 1 })).toBeUndefined();
    const a = await tunnelFor("c1", cfg(ssh), { host: "127.0.0.1", port: echo.port });
    expect(await roundTrip(a!.port, "one")).toBe("one");
    const b = await tunnelFor("c1", cfg(ssh), { host: "127.0.0.1", port: echo.port }); // reconnecting replaces the old one
    expect(b!.port).not.toBe(a!.port);
    await expect(roundTrip(a!.port, "old")).rejects.toThrow();
    await closeTunnel("c1");
    await expect(roundTrip(b!.port, "closed")).rejects.toThrow();
  });
});
