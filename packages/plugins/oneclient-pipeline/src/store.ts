import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizePipeline, type Pipeline, type RunResult, STORE_VERSION } from "./model.js";

const MAX_RUNS = 20;

export interface StoreData {
  version: number;
  pipelines: Pipeline[];
  /** Newest first, per pipeline id. */
  runs: Record<string, RunResult[]>;
}

/** Where pipelines live: `~/.oneclient/pipeline/<connectionId>.json` (or under `$ONECLIENT_HOME`). */
export function dataDir(): string {
  return join(process.env.ONECLIENT_HOME?.trim() || join(homedir(), ".oneclient"), "pipeline");
}

export function migrate(raw: unknown, file = "store"): StoreData {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const v = typeof r.version === "number" ? r.version : 0;
  if (v > STORE_VERSION) throw new Error(`${file} was written by a newer version of the Pipeline plugin (format ${v}; this one reads up to ${STORE_VERSION}). Update the plugin.`);
  return {
    version: STORE_VERSION,
    pipelines: Array.isArray(r.pipelines) ? (r.pipelines as unknown[]).map(normalizePipeline) : [],
    runs: r.runs && typeof r.runs === "object" ? (r.runs as Record<string, RunResult[]>) : {},
  };
}

/** One workspace file, held in memory and written atomically after every change. */
export class PipelineStore {
  private data: StoreData;
  readonly filePath: string;

  constructor(connectionId: string, dir: string = dataDir()) {
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, `${connectionId}.json`);
    this.data = this.load();
  }

  private load(): StoreData {
    if (!existsSync(this.filePath)) return { version: STORE_VERSION, pipelines: [], runs: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      renameSync(this.filePath, `${this.filePath}.broken-${Date.now()}`);
      return { version: STORE_VERSION, pipelines: [], runs: {} };
    }
    return migrate(parsed, this.filePath);
  }

  get(): StoreData {
    return this.data;
  }

  update<T>(fn: (data: StoreData) => T): T {
    const result = fn(this.data);
    for (const id of Object.keys(this.data.runs)) {
      if (!this.data.pipelines.some((p) => p.id === id)) delete this.data.runs[id];
      else if ((this.data.runs[id]?.length ?? 0) > MAX_RUNS) this.data.runs[id]!.length = MAX_RUNS;
    }
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, "utf-8");
    renameSync(tmp, this.filePath);
    return result;
  }
}

const stores = new Map<string, PipelineStore>();

export function storeFor(connectionId: string | undefined): PipelineStore {
  if (!connectionId) throw new Error("No connection id provided.");
  let s = stores.get(connectionId);
  if (!s) {
    s = new PipelineStore(connectionId);
    stores.set(connectionId, s);
  }
  return s;
}

export function dropStore(connectionId: string): void {
  stores.delete(connectionId);
}
