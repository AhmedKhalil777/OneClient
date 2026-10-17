import type { OutputChannelInfo, OutputChannelState, OutputEntry, OutputLevel } from "../../shared/output.js";

const MAX_ENTRIES = 2000;
const MAX_MESSAGE = 4000;
const MAX_DETAIL = 20000;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text);

/**
 * App-wide log channels (the bottom "Output" panel). Plugins write through `PluginContext.createOutputChannel`
 * (and their `logger`); core reads via IPC. Everything stays in memory, capped per channel.
 */
export class OutputService {
  private readonly channels = new Map<string, OutputChannelState>();
  private nextId = 1;
  private readonly entryListeners = new Set<(info: OutputChannelInfo, entry: OutputEntry) => void>();
  private readonly clearListeners = new Set<(channelId: string) => void>();
  private readonly revealListeners = new Set<(channelId: string) => void>();

  private channel(pluginId: string, name: string): OutputChannelState {
    const id = `${pluginId}/${name}`;
    let ch = this.channels.get(id);
    if (!ch) {
      ch = { id, pluginId, name, entries: [] };
      this.channels.set(id, ch);
    }
    return ch;
  }

  append(pluginId: string, name: string, level: OutputLevel, message: string, detail?: string, time: number = Date.now()): void {
    const ch = this.channel(pluginId, name);
    const entry: OutputEntry = { id: this.nextId++, time, level, message: clip(message, MAX_MESSAGE), ...(detail ? { detail: clip(detail, MAX_DETAIL) } : {}) };
    ch.entries.push(entry);
    if (ch.entries.length > MAX_ENTRIES) ch.entries.splice(0, ch.entries.length - MAX_ENTRIES);
    const info: OutputChannelInfo = { id: ch.id, pluginId, name };
    for (const l of this.entryListeners) l(info, entry);
  }

  clear(channelId: string): void {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    ch.entries.length = 0;
    for (const l of this.clearListeners) l(channelId);
  }

  reveal(pluginId: string, name: string): void {
    const ch = this.channel(pluginId, name);
    for (const l of this.revealListeners) l(ch.id);
  }

  /** Drops a plugin's channels (plugin removed). */
  removePlugin(pluginId: string): void {
    for (const [id, ch] of this.channels) if (ch.pluginId === pluginId) this.channels.delete(id);
  }

  snapshot(): OutputChannelState[] {
    return [...this.channels.values()].map((c) => ({ ...c, entries: c.entries.slice() }));
  }

  onEntry(l: (info: OutputChannelInfo, entry: OutputEntry) => void): () => void {
    this.entryListeners.add(l);
    return () => this.entryListeners.delete(l);
  }
  onCleared(l: (channelId: string) => void): () => void {
    this.clearListeners.add(l);
    return () => this.clearListeners.delete(l);
  }
  onReveal(l: (channelId: string) => void): () => void {
    this.revealListeners.add(l);
    return () => this.revealListeners.delete(l);
  }
}
