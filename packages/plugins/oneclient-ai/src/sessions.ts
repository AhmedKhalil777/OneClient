import { PROVIDERS, type ModelRow, MODELS } from "./presets.js";
import { createProvider, isReady } from "./providers/index.js";
import type { AiConfig, ChatProvider } from "./types.js";

interface Session {
  config: AiConfig;
  providers: Map<string, ChatProvider>;
  /** Models each ready provider reported, with when we asked (so opening the picker doesn't hit every API each time). */
  listed: Map<string, { at: number; ids: string[] | null }>;
}

const sessions = new Map<string, Session>();
const LIST_TTL_MS = 10 * 60_000;

export function openSession(connectionId: string, config: AiConfig): Session {
  const session: Session = { config, providers: new Map(), listed: new Map() };
  sessions.set(connectionId, session);
  return session;
}

export function sessionFor(connectionId: string | undefined): Session {
  const s = connectionId ? sessions.get(connectionId) : undefined;
  if (!s) throw new Error("This AI connection is not connected. Connect it from the sidebar first.");
  return s;
}

/** The client for one provider of a connection, created on first use. */
export function providerOf(session: Session, providerId: string): ChatProvider {
  let p = session.providers.get(providerId);
  if (!p) {
    p = createProvider(session.config, providerId);
    session.providers.set(providerId, p);
  }
  return p;
}

export interface PickerRow extends ModelRow {
  providerLabel: string;
  /** Has a key (or needs none). Others are shown dimmed so you can see what adding a key would give you. */
  ready: boolean;
  /** The provider answered and does not list this model. */
  unavailable?: boolean;
}

/** The model table for the picker: curated rows plus any model the providers report, ready providers first. */
export async function modelTable(session: Session, refresh: boolean): Promise<PickerRow[]> {
  const ready = PROVIDERS.filter((p) => isReady(session.config, p));
  await Promise.all(
    ready.map(async (p) => {
      const cached = session.listed.get(p.id);
      if (cached && !refresh && Date.now() - cached.at < LIST_TTL_MS) return;
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 8000);
        const ids = await providerOf(session, p.id).listModels(ac.signal).finally(() => clearTimeout(timer));
        session.listed.set(p.id, { at: Date.now(), ids });
      } catch {
        session.listed.set(p.id, { at: Date.now(), ids: null });
      }
    }),
  );

  const rows: PickerRow[] = [];
  for (const p of PROVIDERS) {
    const isReadyNow = ready.includes(p);
    const listed = session.listed.get(p.id)?.ids ?? null;
    const curated = MODELS.filter((m) => m.provider === p.id);
    for (const m of curated) rows.push({ ...m, providerLabel: p.label, ready: isReadyNow, ...(isReadyNow && listed && !listed.includes(m.id) ? { unavailable: true } : {}) });
    if (isReadyNow && listed) {
      const known = new Set(curated.map((m) => m.id));
      for (const id of listed) if (!known.has(id)) rows.push({ provider: p.id, id, label: id, providerLabel: p.label, ready: true });
    }
  }
  return rows.sort((a, b) => Number(b.ready) - Number(a.ready) || Number(a.unavailable ?? false) - Number(b.unavailable ?? false));
}

export function closeSession(connectionId: string): void {
  sessions.delete(connectionId);
}

export function closeAll(): void {
  sessions.clear();
}
