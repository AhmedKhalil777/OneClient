import { app, safeStorage, utilityProcess } from "electron";
import type { HostProcess, Platform } from "@oneclient/backend/platform/platform.js";

/** The desktop app: helper processes are utilityProcesses, secrets use the OS keychain / DPAPI (safeStorage). */
export function electronPlatform(pluginDirs: string[]): Platform {
  return {
    runtime: "desktop",
    fork: (entry, serviceName) => utilityProcess.fork(entry, [], { serviceName, stdio: "pipe" }) as unknown as HostProcess,
    cipher: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
      decrypt: (ciphertext) => safeStorage.decryptString(Buffer.from(ciphertext, "base64")),
    },
    secretsFile: "secrets.json",
    pluginDirs,
    appVersion: app.getVersion(),
    versions: { electron: process.versions.electron ?? "", chrome: process.versions.chrome ?? "", node: process.versions.node, v8: process.versions.v8 },
  };
}
