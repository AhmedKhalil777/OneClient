import type { TaskInfo } from "../tasks/task-service.js";

export type NotificationSeverity = "info" | "success" | "warning" | "error";

/** A button on a notification: run a command, or jump to a task / an Output channel. */
export interface NotificationAction {
  label: string;
  commandId?: string;
  args?: unknown[];
  showTask?: string;
  showOutput?: string;
}

export interface NotificationInfo {
  id: string;
  /** Who it is from: a plugin's display name, "Git", "oneClient"… */
  source: string;
  pluginId: string;
  severity: NotificationSeverity;
  message: string;
  detail?: string;
  actions: NotificationAction[];
  createdAt: number;
  /** Stays on screen until closed. */
  sticky: boolean;
  /** Kept in the Notification Center only (no toast). */
  silent: boolean;
}

export interface NewNotification {
  pluginId: string;
  source: string;
  severity?: NotificationSeverity;
  message: string;
  detail?: string | undefined;
  actions?: NotificationAction[] | undefined;
  sticky?: boolean | undefined;
  silent?: boolean | undefined;
  /** Same plugin + same key = replace the earlier notification. */
  key?: string | undefined;
}

/** A task that just ended is worth a notification if it failed, or ran long enough that the user probably looked away. */
export const TASK_NOTIFY_AFTER_MS = 3000;

/**
 * The notification (if any) for a task changing state. Only the running → finished transition counts; cancelling is
 * the user's own doing, so it stays quiet.
 */
export function notificationForTask(prev: TaskInfo | undefined, next: TaskInfo): NewNotification | null {
  if (prev?.state !== "running" || next.state === "running" || next.state === "cancelled") return null;
  const ran = (next.endedAt ?? Date.now()) - next.startedAt;
  const actions: NotificationAction[] = [{ label: "Show output", showTask: next.id }];
  if (next.state === "failed") {
    return { pluginId: "core", source: next.source, severity: "error", message: `${next.title} failed`, detail: next.detail, actions, key: `task:${next.id}` };
  }
  if (ran < TASK_NOTIFY_AFTER_MS) return null;
  return { pluginId: "core", source: next.source, severity: "success", message: `${next.title} completed`, detail: next.detail, actions, key: `task:${next.id}` };
}
