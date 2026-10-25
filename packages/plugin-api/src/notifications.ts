/**
 * Notifications: short messages the app shows to the user as toasts (bottom right) and keeps in the Notification
 * Center (the bell in the status bar), like VS Code's. Use them to say that something the user started has
 * finished — an import, a long AI answer, a deployment — or that something needs attention.
 *
 * ```ts
 * context.notifications.success("Import finished: 2,000 rows", { actions: [{ label: "Open table", commandId: "postgres.openTable", args: [{ connectionId }] }] });
 * context.notifications.error("The backup failed", { detail: err.stack });
 * ```
 *
 * Tasks (`context.tasks.run`) already notify when they fail or take a few seconds, so don't repeat that. Don't put
 * secrets in a message: the Notification Center keeps recent ones in memory.
 */
export type NotificationSeverity = "info" | "success" | "warning" | "error";

export interface NotificationAction {
  /** The button's text. */
  label: string;
  /** One of the plugin's commands (or any registered command) to run when the button is pressed. */
  commandId: string;
  args?: unknown[];
}

export interface NotificationOptions {
  /** Default "info". Errors stay on screen until closed; the others fade after a few seconds. */
  severity?: NotificationSeverity;
  /** More text, shown when the notification is expanded (a stack trace, a file list). */
  detail?: string;
  /** Up to three buttons. */
  actions?: NotificationAction[];
  /** Keep the toast on screen until it is closed, whatever its severity. */
  sticky?: boolean;
  /** Put it in the Notification Center without showing a toast. */
  silent?: boolean;
  /**
   * A stable name for "this" notification: showing another with the same key replaces the earlier one (progress
   * that changes, "3 files processed" → "5 files processed") instead of stacking up.
   */
  key?: string;
}

export interface Notifications {
  /** Shows a notification; resolves to its id. */
  show(message: string, options?: NotificationOptions): Promise<{ id: string }>;
  info(message: string, options?: Omit<NotificationOptions, "severity">): Promise<{ id: string }>;
  success(message: string, options?: Omit<NotificationOptions, "severity">): Promise<{ id: string }>;
  warning(message: string, options?: Omit<NotificationOptions, "severity">): Promise<{ id: string }>;
  error(message: string, options?: Omit<NotificationOptions, "severity">): Promise<{ id: string }>;
  /** Removes a notification (its toast and its Notification Center entry). */
  dismiss(id: string): Promise<void>;
}
