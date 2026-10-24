import type { Readable } from "node:stream";

/**
 * What differs between the two runtimes the backend runs in:
 *  - the desktop app (Electron main process): electron-platform.ts
 *  - the self-hosted web server (plain Node, no Electron): node-platform.ts
 * Everything else — plugins, connections, workspace, git, tasks, terminal, search — is shared (backend.ts).
 */

/** A helper process: an extension host or the terminal host. */
export interface HostProcess {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  kill(): boolean;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
}

/** Encrypts secrets before they touch disk (secrets.json). */
export interface SecretCipher {
  available(): boolean;
  /** base64 ciphertext */
  encrypt(plain: string): string;
  /** Throws when the ciphertext isn't ours (another user, machine or key). */
  decrypt(ciphertext: string): string;
}

export interface Platform {
  readonly runtime: "desktop" | "web";
  /** Runs one of core's built entry points (out/main/extension-host.js, terminal-host.js) in its own process. */
  fork(entry: string, serviceName: string): HostProcess;
  readonly cipher: SecretCipher;
  /** File name of the secrets store inside the config folder. The runtimes encrypt differently, so they keep separate files. */
  readonly secretsFile: string;
  /** Where plugins are loaded from. */
  readonly pluginDirs: string[];
  readonly appVersion: string;
  /** Versions shown in Help ▸ About. */
  readonly versions: { electron: string; chrome: string; node: string; v8: string };
}
