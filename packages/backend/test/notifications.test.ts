import { describe, expect, it } from "vitest";
import { NotificationService } from "../src/notifications/notification-service.js";
import { notificationForTask } from "../src/shared/notifications.js";
import type { TaskInfo } from "../src/tasks/task-service.js";

const task = (over: Partial<TaskInfo> = {}): TaskInfo => ({ id: "t1", title: "Build", source: "npm", state: "running", startedAt: 1000, cancellable: true, ...over });

describe("notificationForTask", () => {
  it("says nothing while running, for quick successes and for cancels", () => {
    expect(notificationForTask(undefined, task())).toBeNull();
    expect(notificationForTask(task(), task())).toBeNull();
    expect(notificationForTask(task(), task({ state: "succeeded", endedAt: 2000 }))).toBeNull();
    expect(notificationForTask(task(), task({ state: "cancelled", endedAt: 9000 }))).toBeNull();
  });
  it("reports a slow success and every failure, with a way to the output", () => {
    const ok = notificationForTask(task(), task({ state: "succeeded", endedAt: 9000 }))!;
    expect(ok).toMatchObject({ severity: "success", message: "Build completed", source: "npm", key: "task:t1" });
    expect(ok.actions).toEqual([{ label: "Show output", showTask: "t1" }]);
    const bad = notificationForTask(task(), task({ state: "failed", endedAt: 1100, detail: "exit 1" }))!;
    expect(bad).toMatchObject({ severity: "error", message: "Build failed", detail: "exit 1" });
  });
  it("ignores a task that finished before we saw it run", () => {
    expect(notificationForTask(undefined, task({ state: "failed", endedAt: 2000 }))).toBeNull();
  });
});

describe("NotificationService", () => {
  const base = { pluginId: "p", source: "P", message: "hello" };

  it("keeps errors sticky by default and clips actions", () => {
    const s = new NotificationService();
    expect(s.show({ ...base, severity: "error" }).sticky).toBe(true);
    expect(s.show({ ...base, severity: "success" }).sticky).toBe(false);
    const n = s.show({ ...base, actions: [1, 2, 3, 4, 5].map((i) => ({ label: `a${i}`, commandId: "x" })) });
    expect(n.actions).toHaveLength(3);
    expect(s.show({ ...base, actions: [{ label: "" }] }).actions).toEqual([]);
  });

  it("replaces a notification with the same key instead of stacking", () => {
    const s = new NotificationService();
    const seen: string[] = [];
    s.onAdded((n) => seen.push(n.message));
    s.show({ ...base, message: "3 files", key: "progress" });
    s.show({ ...base, message: "5 files", key: "progress" });
    expect(s.list().map((n) => n.message)).toEqual(["5 files"]);
    expect(seen).toEqual(["3 files", "5 files"]);
    // another plugin's key is a different notification
    s.show({ ...base, pluginId: "q", message: "other", key: "progress" });
    expect(s.list()).toHaveLength(2);
  });

  it("dismisses, clears, drops a plugin's, and caps history", () => {
    const s = new NotificationService();
    const dismissed: string[] = [];
    let cleared = 0;
    s.onDismissed((id) => dismissed.push(id));
    s.onCleared(() => cleared++);
    const a = s.show(base);
    s.show({ ...base, pluginId: "q" });
    s.dismiss(a.id);
    s.dismiss("nope");
    expect(dismissed).toEqual([a.id]);
    s.removePlugin("q");
    expect(s.list()).toEqual([]);
    for (let i = 0; i < 130; i++) s.show({ ...base, message: String(i) });
    expect(s.list()).toHaveLength(100);
    s.clear();
    s.clear();
    expect(cleared).toBe(1);
  });

  it("clips long text", () => {
    const n = new NotificationService().show({ ...base, message: "x".repeat(2000), detail: "y".repeat(50_000) });
    expect(n.message.length).toBeLessThanOrEqual(601);
    expect(n.detail!.length).toBeLessThanOrEqual(20_001);
  });
});
