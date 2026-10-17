import type { SearchProviderContribution, SearchResult } from "@oneclient/plugin-api";
import type { ConnectionManager } from "../connections/connection-manager.js";
import type { ContributionRegistry } from "../plugins/registry.js";

export interface SearchProviderInfo {
  id: string;
  pluginId: string;
  label: string;
  icon?: string | undefined;
  order: number;
}

/** A result plus where it came from, so the shell can open it on the right connection. */
export interface SearchHit extends SearchResult {
  providerId: string;
  pluginId: string;
  connectionId: string;
  connectionName: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** Connections that could not be searched (not reachable, plugin error, timed out) — shown as a hint, never fatal. */
  problems: Array<{ connectionName: string; message: string }>;
}

type Invoke = (pluginId: string, kind: "command", target: string, method: string, args: unknown[], connectionId?: string) => Promise<unknown>;

const CONNECT_TIMEOUT_MS = 8000;
const SEARCH_TIMEOUT_MS = 10000;
const MAX_HITS_PER_CONNECTION = 60;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s.`)), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

const clean = (v: unknown, max = 300): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);

/** Validates what a plugin returned: it is untrusted data, so keep only well-formed, bounded fields. */
function sanitize(raw: unknown): SearchResult[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchResult[] = [];
  for (const r of raw.slice(0, MAX_HITS_PER_CONNECTION)) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const label = clean(o.label);
    if (!label) continue;
    const hit: Record<string, unknown> = { label };
    const id = clean(o.id, 600);
    if (id) hit.id = id;
    const description = clean(o.description, 400);
    if (description) hit.description = description;
    const icon = clean(o.icon, 60);
    if (icon) hit.icon = icon;
    const res = o.resource as { name?: unknown; kind?: unknown } | undefined;
    if (res && typeof res.name === "string" && (res.kind === "file" || res.kind === "folder")) hit.resource = { name: res.name.slice(0, 260), kind: res.kind };
    const ov = o.openView as { viewId?: unknown; title?: unknown; params?: unknown; icon?: unknown } | undefined;
    if (ov && typeof ov.viewId === "string") {
      const params: Record<string, string> = {};
      if (ov.params && typeof ov.params === "object") for (const [k, v] of Object.entries(ov.params)) if (typeof v === "string") params[k] = v.slice(0, 2000);
      hit.openView = { viewId: ov.viewId, ...(clean(ov.title) ? { title: clean(ov.title) } : {}), params, ...(clean(ov.icon, 60) ? { icon: clean(ov.icon, 60) } : {}) };
    }
    const cmd = o.command as { id?: unknown; args?: unknown } | undefined;
    if (cmd && typeof cmd.id === "string") hit.command = { id: cmd.id, ...(cmd.args && typeof cmd.args === "object" ? { args: cmd.args } : {}) };
    if (hit.openView || hit.command) out.push(hit as unknown as SearchResult);
  }
  return out;
}

/**
 * The top-bar "search everything": asks every plugin that declared a search provider (`contributes.searchProviders`)
 * to search each of its saved connections, and returns the results tagged with their origin. Providers are queried
 * one at a time by the shell (see `run`), so a quick one shows its results while a slow one is still working.
 */
export class SearchService {
  constructor(
    private readonly registry: ContributionRegistry,
    private readonly connections: ConnectionManager,
    private readonly invoke: Invoke,
  ) {}

  providers(): SearchProviderInfo[] {
    return this.registry
      .snapshot()
      .searchProviders.map((p) => ({ id: `${p.pluginId}:${p.id}`, pluginId: p.pluginId, label: p.label, icon: p.icon, order: p.order ?? 100 }))
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }

  async run(providerId: string, query: string, limit = 20): Promise<SearchOutcome> {
    const provider = this.registry.snapshot().searchProviders.find((p) => `${p.pluginId}:${p.id}` === providerId) as (SearchProviderContribution & { pluginId: string }) | undefined;
    const outcome: SearchOutcome = { hits: [], problems: [] };
    const text = query.trim();
    if (!provider || !text) return outcome;

    const targets = this.connections.list().filter((c) => c.pluginId === provider.pluginId && (!provider.connectionType || c.typeId === provider.connectionType));
    await Promise.all(
      targets.map(async (c) => {
        try {
          await withTimeout(this.connections.ensureConnected(c.id), CONNECT_TIMEOUT_MS, "Connecting");
          const raw = await withTimeout(this.invoke(provider.pluginId, "command", provider.command, "execute", [{ query: text, connectionId: c.id, limit }], c.id), SEARCH_TIMEOUT_MS, "The search");
          for (const r of sanitize(raw)) outcome.hits.push({ ...r, providerId, pluginId: provider.pluginId, connectionId: c.id, connectionName: c.name });
        } catch (err) {
          outcome.problems.push({ connectionName: c.name, message: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    return outcome;
  }
}
