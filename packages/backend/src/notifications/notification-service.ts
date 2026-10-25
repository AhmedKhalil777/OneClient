import { randomUUID } from "node:crypto";
import type { NewNotification, NotificationAction, NotificationInfo } from "../shared/notifications.js";

const MAX_KEPT = 100;
const MAX_MESSAGE = 600;
const MAX_DETAIL = 20_000;
const MAX_ACTIONS = 3;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * The Notification Center's backend: plugins (`context.notifications`) and core (finished tasks) post here; the
 * shell shows toasts for new ones and lists the recent ones. In memory only, newest last.
 */
export class NotificationService {
  private items: NotificationInfo[] = [];
  private readonly addedListeners = new Set<(n: NotificationInfo) => void>();
  private readonly dismissedListeners = new Set<(id: string) => void>();
  private readonly clearedListeners = new Set<() => void>();

  list(): NotificationInfo[] {
    return this.items.slice();
  }

  show(input: NewNotification): NotificationInfo {
    const severity = input.severity ?? "info";
    const id = input.key ? `${input.pluginId}:${input.key}` : randomUUID();
    const actions: NotificationAction[] = (input.actions ?? []).slice(0, MAX_ACTIONS).map((a) => ({
      label: clip(String(a.label ?? ""), 40),
      ...(a.commandId ? { commandId: a.commandId } : {}),
      ...(a.args ? { args: a.args } : {}),
      ...(a.showTask ? { showTask: a.showTask } : {}),
      ...(a.showOutput ? { showOutput: a.showOutput } : {}),
    }));
    const info: NotificationInfo = {
      id,
      source: input.source,
      pluginId: input.pluginId,
      severity,
      message: clip(String(input.message ?? ""), MAX_MESSAGE),
      ...(input.detail ? { detail: clip(input.detail, MAX_DETAIL) } : {}),
      actions: actions.filter((a) => a.label),
      createdAt: Date.now(),
      sticky: input.sticky ?? severity === "error",
      silent: input.silent === true,
    };
    this.items = this.items.filter((n) => n.id !== id);
    this.items.push(info);
    if (this.items.length > MAX_KEPT) this.items.splice(0, this.items.length - MAX_KEPT);
    for (const l of this.addedListeners) l(info);
    return info;
  }

  dismiss(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((n) => n.id !== id);
    if (this.items.length !== before) for (const l of this.dismissedListeners) l(id);
  }

  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    for (const l of this.clearedListeners) l();
  }

  /** Drops a removed or disabled plugin's notifications. */
  removePlugin(pluginId: string): void {
    for (const n of this.items.filter((x) => x.pluginId === pluginId)) this.dismiss(n.id);
  }

  onAdded(l: (n: NotificationInfo) => void): () => void {
    this.addedListeners.add(l);
    return () => this.addedListeners.delete(l);
  }
  onDismissed(l: (id: string) => void): () => void {
    this.dismissedListeners.add(l);
    return () => this.dismissedListeners.delete(l);
  }
  onCleared(l: () => void): () => void {
    this.clearedListeners.add(l);
    return () => this.clearedListeners.delete(l);
  }
}
