import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonSchemaObject } from "@oneclient/plugin-api";
import { Client, type ConnectConfig } from "ssh2";
import { dataHome } from "../paths.js";

/**
 * SSH tunnels for SQL connections: one SSH connection per saved connection, with a local listener on 127.0.0.1 that
 * forwards every database socket over its own channel of that connection (so a pool of 10 connections is one SSH login,
 * not ten). The plugin points its driver at the local port instead of the database host.
 */

export const SSH_AUTH_PASSWORD = "Password";
export const SSH_AUTH_KEY = "Private key file";
export const SSH_AUTH_AGENT = "SSH agent";

export interface SshConfig {
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuth?: string;
  sshPassword?: string;
  /** Path of a private key file (OpenSSH or PEM); `~` is the home folder. */
  sshKeyFile?: string;
  sshPassphrase?: string;
}

/** The form fields every SQL plugin adds to its connection `configSchema` (all optional: no SSH host = no tunnel). */
export const sshSchemaProperties: Record<string, JsonSchemaObject> = {
  sshHost: { type: "string", title: "SSH tunnel: host", description: "Connect through this SSH server (bastion). Leave empty to connect directly." },
  sshPort: { type: "number", title: "SSH tunnel: port", default: 22 },
  sshUser: { type: "string", title: "SSH tunnel: user" },
  sshAuth: { type: "string", title: "SSH tunnel: sign in with", enum: [SSH_AUTH_PASSWORD, SSH_AUTH_KEY, SSH_AUTH_AGENT], default: SSH_AUTH_PASSWORD },
  sshPassword: { type: "string", title: "SSH tunnel: password", "x-secret": true },
  sshKeyFile: { type: "string", title: "SSH tunnel: private key file", description: "e.g. ~/.ssh/id_ed25519" },
  sshPassphrase: { type: "string", title: "SSH tunnel: key passphrase", "x-secret": true },
};

export const sshEnabled = (c: SshConfig): boolean => !!c.sshHost?.trim();

export interface Tunnel {
  /** Always 127.0.0.1. */
  host: string;
  /** The local port that reaches the database through the SSH server. */
  port: number;
  close(): Promise<void>;
}

export interface TunnelTarget {
  host: string;
  port: number;
}

// ---- host keys: trust on first use, refuse a changed key ---------------------------------------------------------

const knownHostsFile = () => join(dataHome(), "ssh-known-hosts.json");

function readKnown(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(knownHostsFile(), "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Remembers the server's key on first contact; afterwards a different key is refused (a changed key can mean someone is in the middle). */
export function checkHostKey(hostPort: string, fingerprint: string): { ok: true; firstUse: boolean } | { ok: false; expected: string } {
  const known = readKnown();
  const have = known[hostPort];
  if (have === undefined) {
    const file = knownHostsFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...known, [hostPort]: fingerprint }, null, 2)}\n`, "utf-8");
    renameSync(`${file}.tmp`, file);
    return { ok: true, firstUse: true };
  }
  return have === fingerprint ? { ok: true, firstUse: false } : { ok: false, expected: have };
}

// ---- the tunnel --------------------------------------------------------------------------------------------------

const expandHome = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** The Windows OpenSSH agent's pipe, or $SSH_AUTH_SOCK elsewhere (Pageant is tried too on Windows). */
const agentPath = () => process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined);

/** Set by the host key check, so the connect error can say why instead of "verification failed". */
interface Attempt {
  hostKeyError?: Error;
}

function connectConfig(cfg: SshConfig, attempt: Attempt): ConnectConfig {
  const host = cfg.sshHost!.trim();
  const port = Number(cfg.sshPort) || 22;
  const username = cfg.sshUser?.trim();
  if (!username) throw new Error("SSH tunnel: enter the SSH user.");
  const base: ConnectConfig = {
    host,
    port,
    username,
    readyTimeout: 15_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    hostHash: "sha256",
    hostVerifier: (fingerprint: string): boolean => {
      const r = checkHostKey(`${host}:${port}`, `SHA256:${fingerprint}`);
      if (r.ok) return true;
      attempt.hostKeyError = new Error(`SSH tunnel: the host key of ${host}:${port} has changed (expected ${r.expected}, got SHA256:${fingerprint}). Connection refused — if the server was reinstalled, remove its entry from ssh-known-hosts.json in your oneClient folder.`);
      return false;
    },
  };
  const auth = cfg.sshAuth || SSH_AUTH_PASSWORD;
  if (auth === SSH_AUTH_KEY) {
    const file = cfg.sshKeyFile?.trim();
    if (!file) throw new Error("SSH tunnel: choose a private key file.");
    const path = expandHome(file);
    if (!existsSync(path)) throw new Error(`SSH tunnel: the key file ${path} doesn't exist.`);
    return { ...base, privateKey: readFileSync(path), ...(cfg.sshPassphrase ? { passphrase: cfg.sshPassphrase } : {}) };
  }
  if (auth === SSH_AUTH_AGENT) {
    const agent = agentPath();
    if (!agent) throw new Error("SSH tunnel: no SSH agent found (SSH_AUTH_SOCK is not set).");
    return { ...base, agent };
  }
  return { ...base, password: cfg.sshPassword ?? "" };
}

function connectClient(cfg: SshConfig): Promise<Client> {
  const attempt: Attempt = {};
  const opts = connectConfig(cfg, attempt);
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", (err) => reject(attempt.hostKeyError ?? describe(err, opts)));
    client.connect(opts);
  });
}

function describe(err: Error & { level?: string }, opts: ConnectConfig): Error {
  const where = `${opts.host}:${opts.port}`;
  if (err.level === "client-authentication") return new Error(`SSH tunnel: ${where} refused the sign-in (wrong user, password or key).`);
  if (/ENOTFOUND|EAI_AGAIN/.test(err.message)) return new Error(`SSH tunnel: can't find the host ${opts.host}.`);
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/.test(err.message) || err.level === "client-timeout") return new Error(`SSH tunnel: can't reach ${where} (${err.message}).`);
  return new Error(err.message.startsWith("SSH tunnel") ? err.message : `SSH tunnel: ${err.message}`);
}

/**
 * Opens the SSH connection (failing here, with a readable message, when the host, sign-in or host key is wrong) and the
 * local listener. If the SSH connection drops later, the next database socket reconnects it.
 */
export async function openTunnel(cfg: SshConfig, target: TunnelTarget): Promise<Tunnel> {
  let client: Client | null = await connectClient(cfg);
  let reconnecting: Promise<Client> | null = null;

  const watch = (c: Client) => {
    const gone = () => {
      if (client === c) client = null;
    };
    c.on("close", gone);
    c.on("error", gone); // a dropped link must not crash the extension host; the next socket reconnects
  };
  watch(client);

  const live = async (): Promise<Client> => {
    if (client) return client;
    reconnecting ??= connectClient(cfg)
      .then((c) => (watch(c), (client = c)))
      .finally(() => (reconnecting = null));
    return reconnecting;
  };

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.pause(); // nothing is read until the channel is open, so the first bytes aren't lost
    live().then(
      (c) =>
        c.forwardOut(socket.remoteAddress ?? "127.0.0.1", socket.remotePort ?? 0, target.host, target.port, (err, stream) => {
          if (err) return socket.destroy();
          stream.on("error", () => socket.destroy());
          stream.on("close", () => socket.destroy());
          socket.on("close", () => stream.destroy());
          socket.pipe(stream).pipe(socket);
          socket.resume();
        }),
      () => socket.destroy(),
    );
  });
  server.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  }).catch((err) => {
    client?.end();
    throw err;
  });

  return {
    host: "127.0.0.1",
    port: (server.address() as net.AddressInfo).port,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      client?.end();
      client = null;
    },
  };
}

// ---- one tunnel per saved connection -------------------------------------------------------------------------------

const open = new Map<string, Tunnel>();

/** The connection's tunnel (opened on first use), or undefined when no SSH host is configured. */
export async function tunnelFor(connectionId: string, cfg: SshConfig, target: TunnelTarget): Promise<Tunnel | undefined> {
  await closeTunnel(connectionId);
  if (!sshEnabled(cfg)) return undefined;
  const tunnel = await openTunnel(cfg, target);
  open.set(connectionId, tunnel);
  return tunnel;
}

export async function closeTunnel(connectionId: string): Promise<void> {
  const t = open.get(connectionId);
  open.delete(connectionId);
  await t?.close();
}
