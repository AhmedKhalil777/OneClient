import { type ChildProcess, fork } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HostProcess, SecretCipher } from "./platform.js";

/**
 * Helper processes as plain Node children. Messages are structured clones (`serialization: "advanced"`), like
 * Electron's utilityProcess. When the server itself runs on Electron's binary (the installed app's `--serve`), the
 * children must run as Node too.
 */
export function forkNode(entry: string, serviceName: string): HostProcess {
  const child: ChildProcess = fork(entry, [], {
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, ONECLIENT_SERVICE: serviceName, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    execArgv: [],
  });
  const handle = {
    postMessage(message: unknown) {
      if (child.connected) child.send(message as never);
    },
    on(event: "message" | "exit", listener: (value: never) => void) {
      if (event === "message") child.on("message", listener as (m: unknown) => void);
      else child.on("exit", (code, signal) => (listener as (c: number) => void)(code ?? (signal ? 1 : 0)));
      return handle;
    },
    kill: () => child.kill(),
    stdout: child.stdout,
    stderr: child.stderr,
  };
  return handle as HostProcess;
}

/**
 * AES-256-GCM with a 32-byte key from `ONECLIENT_SECRET_KEY` (base64 or hex), else from a key file created next to
 * the secrets (readable only by this user). Keep the key file out of backups you share — whoever has both files
 * can read the passwords.
 */
export class KeyFileCipher implements SecretCipher {
  private readonly key: Buffer;

  constructor(keyFile: string, envKey = process.env.ONECLIENT_SECRET_KEY) {
    this.key = envKey?.trim() ? parseKey(envKey.trim()) : loadOrCreateKey(keyFile);
  }

  available(): boolean {
    return true;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    // v1 | iv (12) | tag (16) | data
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), data]).toString("base64");
  }

  decrypt(ciphertext: string): string {
    const raw = Buffer.from(ciphertext, "base64");
    if (raw.length < 29 || raw[0] !== 1) throw new Error("Not a oneClient server secret.");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(1, 13));
    decipher.setAuthTag(raw.subarray(13, 29));
    return Buffer.concat([decipher.update(raw.subarray(29)), decipher.final()]).toString("utf8");
  }
}

function parseKey(text: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  if (key.length !== 32) throw new Error("ONECLIENT_SECRET_KEY must be 32 bytes (64 hex characters or base64).");
  return key;
}

function loadOrCreateKey(file: string): Buffer {
  if (existsSync(file)) return parseKey(readFileSync(file, "utf8").trim());
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, `${key.toString("hex")}\n`, { encoding: "utf8", mode: 0o600 });
  return key;
}
