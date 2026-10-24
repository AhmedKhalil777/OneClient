import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Runtime = "desktop" | "web";

export class InstanceLockError extends Error {}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

/**
 * The desktop app and the web server must not use the same config folder at the same time: each keeps oneclient.json
 * in memory, so the last one to save would silently drop the other's changes. Each runtime marks the folder
 * (`<runtime>.lock` with its pid) and refuses to start while the *other* runtime's mark belongs to a live process.
 * (Several desktop windows of one app are fine — that's one process.) Returns the function that removes the mark.
 */
export function acquireInstanceLock(configDir: string, runtime: Runtime): () => void {
  const other: Runtime = runtime === "desktop" ? "web" : "desktop";
  const otherFile = join(configDir, `${other}.lock`);
  if (existsSync(otherFile)) {
    const pid = Number(readFileSync(otherFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
      throw new InstanceLockError(
        `${other === "web" ? "The oneClient web server" : "The oneClient desktop app"} (process ${pid}) is using ${configDir}. ` +
          `Stop it first, or give this one its own folder with the ONECLIENT_HOME environment variable.`,
      );
    }
  }
  mkdirSync(configDir, { recursive: true });
  const mine = join(configDir, `${runtime}.lock`);
  writeFileSync(mine, `${process.pid}\n`, "utf8");
  return () => {
    try {
      if (existsSync(mine) && readFileSync(mine, "utf8").trim() === String(process.pid)) rmSync(mine);
    } catch {
      // best effort
    }
  };
}
