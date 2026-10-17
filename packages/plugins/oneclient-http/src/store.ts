import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Workspace, WORKSPACE_VERSION } from "./model.js";

const MAX_HISTORY = 200;

/** Where workspaces live: `~/.oneclient/http/<connectionId>.json` (or under `$ONECLIENT_HOME`). */
export function dataDir(): string {
  return join(process.env.ONECLIENT_HOME?.trim() || join(homedir(), ".oneclient"), "http");
}

export class WorkspaceVersionError extends Error {
  constructor(file: string, found: number) {
    super(`${file} was written by a newer version of the HTTP plugin (format ${found}; this one reads up to ${WORKSPACE_VERSION}). Update the plugin.`);
    this.name = "WorkspaceVersionError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Brings a stored workspace up to WORKSPACE_VERSION.
 * To change the format: bump WORKSPACE_VERSION, add `if (v === N) { …; v = N + 1; }` below, add a test.
 */
export function migrateWorkspace(raw: unknown, file = "workspace"): Workspace {
  if (!isObject(raw)) throw new Error("not a JSON object");
  let v = typeof raw.version === "number" ? raw.version : 0;
  if (v > WORKSPACE_VERSION) throw new WorkspaceVersionError(file, v);
  const data: Record<string, unknown> = { ...raw };
  if (v === 0) {
    // Unversioned: fill in anything missing.
    data.collections = Array.isArray(data.collections) ? data.collections : [];
    data.environments = Array.isArray(data.environments) ? data.environments : [];
    data.history = Array.isArray(data.history) ? data.history : [];
    v = 1;
  }
  return {
    version: WORKSPACE_VERSION,
    collections: (data.collections as Workspace["collections"]) ?? [],
    environments: (data.environments as Workspace["environments"]) ?? [],
    activeEnvironmentId: typeof data.activeEnvironmentId === "string" ? data.activeEnvironmentId : undefined,
    history: (data.history as Workspace["history"]) ?? [],
  };
}

/** One workspace file, held in memory and written atomically after every change. */
export class WorkspaceStore {
  private data: Workspace;
  readonly filePath: string;

  constructor(connectionId: string, dir: string = dataDir()) {
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, `${connectionId}.json`);
    this.data = this.load();
  }

  private load(): Workspace {
    if (!existsSync(this.filePath)) return { version: WORKSPACE_VERSION, collections: [], environments: [], history: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      renameSync(this.filePath, `${this.filePath}.broken-${Date.now()}`);
      return { version: WORKSPACE_VERSION, collections: [], environments: [], history: [] };
    }
    return migrateWorkspace(parsed, this.filePath);
  }

  get(): Workspace {
    return this.data;
  }

  /** Mutate the workspace, then persist. */
  update<T>(fn: (ws: Workspace) => T): T {
    const result = fn(this.data);
    if (this.data.history.length > MAX_HISTORY) this.data.history.length = MAX_HISTORY;
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, "utf-8");
    renameSync(tmp, this.filePath);
    return result;
  }
}

const stores = new Map<string, WorkspaceStore>();

export function workspaceFor(connectionId: string | undefined): WorkspaceStore {
  if (!connectionId) throw new Error("No connection id provided.");
  let s = stores.get(connectionId);
  if (!s) {
    s = new WorkspaceStore(connectionId);
    stores.set(connectionId, s);
  }
  return s;
}

export function dropWorkspace(connectionId: string): void {
  stores.delete(connectionId);
}
