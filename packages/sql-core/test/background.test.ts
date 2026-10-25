import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, TaskOptions } from "@oneclient/plugin-api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_RUNNING, createBackground, errorSummary, formatElapsed, titleOf } from "../src/background/manager.js";
import { createBackgroundStore } from "../src/background/store.js";
import { createHistoryStore } from "../src/history.js";
import { createQueryWindowFactory } from "../src/query-window.js";
import { combineSections, createBackgroundSection, createHistorySection, dayLabel, describeTask, oneLine } from "../src/sections.js";
import type { ExecuteQueryRequest, QueryRunSummary } from "../src/types.js";

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "oc-bg-"));
  process.env.ONECLIENT_HOME = home;
});
afterAll(async () => {
  delete process.env.ONECLIENT_HOME;
  await rm(home, { recursive: true, force: true });
});

/** A database whose queries finish when the test says so. */
function fakeDb() {
  const pending = new Map<string, { resolve(run: QueryRunSummary): void; reject(err: Error): void; request: ExecuteQueryRequest }>();
  const cancelled: string[] = [];
  const released: string[] = [];
  return {
    pending,
    cancelled,
    released,
    executeQuery: (request: ExecuteQueryRequest) => new Promise<QueryRunSummary>((resolve, reject) => pending.set(request.queryId, { resolve, reject, request })),
    cancelQuery: (queryId: string) => (cancelled.push(queryId), true),
    releaseWindow: async (_c: string, windowId: string) => void released.push(windowId),
  };
}

const run = (over: Partial<QueryRunSummary> & Record<string, unknown> = {}): QueryRunSummary => ({
  resultSets: [{ columns: [{ name: "n", type: "int" }], rows: [[1], [2], [3]], totalRows: 3 }] as never,
  messages: [{ kind: "info", text: "(3 rows)" }],
  hasErrors: false,
  cancelled: false,
  elapsedMs: 5,
  database: "shop",
  rowsAffected: 0,
  ...over,
});

/** The app side: runs the task body at once, remembers what it reported, counts sidebar refreshes. */
function fakeHost() {
  const events = { started: [] as TaskOptions[], logs: [] as string[], reports: [] as string[], refreshes: [] as string[], outcomes: [] as Array<"ok" | string> };
  const cancelListeners: Array<() => void> = [];
  return {
    events,
    cancelListeners,
    tasks: {
      async run<T>(options: TaskOptions, work: (task: Task) => Promise<T>): Promise<T> {
        events.started.push(options);
        const task: Task = {
          log: (t) => void events.logs.push(t),
          report: (u) => void (u.detail && events.reports.push(u.detail)),
          isCancelled: false,
          onCancel: (l) => (cancelListeners.push(l), { dispose() {} }),
        };
        try {
          const result = await work(task);
          events.outcomes.push("ok");
          return result;
        } catch (err) {
          events.outcomes.push((err as Error).message);
          throw err;
        }
      },
    },
    refreshExplorer: (c: string) => void events.refreshes.push(c),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

describe("background tasks", () => {
  let db: ReturnType<typeof fakeDb>;
  let host: ReturnType<typeof fakeHost>;
  let n = 0;
  const conn = () => `c${++n}`;
  beforeEach(() => {
    db = fakeDb();
    host = fakeHost();
  });

  function make(dataDir = "bg-test") {
    const history = createHistoryStore(dataDir);
    return { history, store: createBackgroundStore(dataDir), background: createBackground({ productName: "Test DB", host, store: createBackgroundStore(dataDir), executeQuery: db.executeQuery, cancelQuery: db.cancelQuery, releaseWindow: db.releaseWindow, history, describeError: (e) => (e as Error).message }) };
  }

  it("runs a script on its own session, shows up as an app task, and keeps the results", async () => {
    const { background, history } = make();
    const c = conn();
    const info = await background.start({ connectionId: c, sql: "-- nightly\nSELECT *\n  FROM orders", database: "shop" });
    expect(info).toMatchObject({ state: "running", title: "SELECT * FROM orders", database: "shop" });
    expect(host.events.started).toEqual([{ title: "Test DB: SELECT * FROM orders", cancellable: true }]);
    expect(host.events.refreshes).toEqual([c]); // the sidebar shows it at once
    await tick();
    const [only] = [...db.pending.values()];
    expect(only!.request).toMatchObject({ connectionId: c, database: "shop", windowId: `bg-${info.id}` }); // its own session

    expect((await background.list(c))[0]).toMatchObject({ id: info.id, state: "running" });
    only!.resolve(run());
    await tick();
    await tick();

    const done = (await background.list(c))[0]!;
    expect(done).toMatchObject({ state: "done", rows: 3, resultSets: 1, hasErrors: false });
    const detail = await background.get(c, info.id);
    expect(detail.result?.resultSets[0]!.rows).toEqual([[1], [2], [3]]);
    expect(host.events.outcomes).toEqual(["ok"]);
    expect(host.events.logs.join("")).toMatch(/Finished after .* — 3 rows\./);
    expect(host.events.refreshes).toEqual([c, c]); // and again when it ends
    expect(db.released).toEqual([`bg-${info.id}`]); // its connection is closed
    expect((await history.list(c))[0]).toMatchObject({ sql: expect.stringContaining("FROM orders"), status: "ok", rows: 3 });
  });

  it("marks a failing script as failed, with the server's message, in the app's task list too", async () => {
    const { background } = make();
    const c = conn();
    const info = await background.start({ connectionId: c, sql: "SELECT boom" });
    await tick();
    [...db.pending.values()][0]!.resolve(run({ hasErrors: true, resultSets: [], messages: [{ kind: "error", text: "Invalid column name 'boom'.\nLine 1" }] as never }));
    await tick();
    await tick();
    expect(await background.get(c, info.id)).toMatchObject({ state: "failed", error: "Invalid column name 'boom'.", hasErrors: true });
    expect(host.events.outcomes).toEqual(["Invalid column name 'boom'."]);
  });

  it("marks a lost connection as failed too", async () => {
    const { background } = make();
    const c = conn();
    const info = await background.start({ connectionId: c, sql: "SELECT 1" });
    await tick();
    [...db.pending.values()][0]!.reject(new Error("Connection lost"));
    await tick();
    await tick();
    expect(await background.get(c, info.id)).toMatchObject({ state: "failed", error: "Connection lost" });
  });

  it("cancels a running task through the database, from the view or the Tasks panel's Stop", async () => {
    const { background } = make();
    const c = conn();
    const a = await background.start({ connectionId: c, sql: "SELECT SLEEP(99)" });
    await tick();
    expect(await background.cancel(a.id)).toBe(true);
    expect(db.cancelled).toEqual([`${a.id}-q`]);
    [...db.pending.values()][0]!.resolve(run({ cancelled: true, hasErrors: true, resultSets: [] as never, messages: [{ kind: "error", text: "Query was cancelled by user." }] as never }));
    await tick();
    await tick();
    expect(await background.get(c, a.id)).toMatchObject({ state: "cancelled" });
    expect(await background.cancel(a.id)).toBe(false); // nothing left to stop

    const b = await background.start({ connectionId: c, sql: "SELECT SLEEP(98)" });
    await tick();
    host.cancelListeners[host.cancelListeners.length - 1]!(); // the Stop button of the Tasks panel
    expect(db.cancelled).toContain(`${b.id}-q`);
  });

  it("limits how many run at once on one connection, and refuses removing a running one", async () => {
    const { background } = make();
    const c = conn();
    const first = await background.start({ connectionId: c, sql: "SELECT 0" });
    for (let i = 1; i < MAX_RUNNING; i++) await background.start({ connectionId: c, sql: `SELECT ${i}` });
    await expect(background.start({ connectionId: c, sql: "SELECT 99" })).rejects.toThrow(/already running/);
    await expect(background.start({ connectionId: conn(), sql: "SELECT 1" })).resolves.toBeDefined(); // another connection is free
    await expect(background.remove(c, first.id)).rejects.toThrow(/Cancel the task/);
    await expect(background.start({ connectionId: c, sql: "   " })).rejects.toThrow(/nothing to run/);
  });

  it("survives a restart: results can be opened again, and a task that was running is marked interrupted", async () => {
    const dir = "bg-restart";
    const first = make(dir);
    const c = conn();
    const finished = await first.background.start({ connectionId: c, sql: "SELECT many" });
    await tick();
    [...db.pending.values()][0]!.resolve(run({ resultSets: [{ columns: [{ name: "n", type: "int" }], rows: Array.from({ length: 1500 }, (_, i) => [i]), totalRows: 1500 }] as never }));
    await tick();
    await tick();
    const stillRunning = await first.background.start({ connectionId: c, sql: "SELECT forever" });
    await tick();

    // "The app restarts": a new manager and store on the same folder know nothing of the running task.
    const second = make(dir);
    const list = await second.background.list(c);
    expect(list.find((t) => t.id === finished.id)).toMatchObject({ state: "done", rows: 1500 });
    expect(list.find((t) => t.id === stillRunning.id)).toMatchObject({ state: "interrupted", error: expect.stringMatching(/closed while this was running/) });
    const detail = await second.background.get(c, finished.id);
    expect(detail.result?.resultSets[0]!.rows).toHaveLength(1000); // only the first 1,000 rows are kept on disk
    expect(detail.result?.resultSets[0]!.totalRows).toBe(1500);
    expect(detail.keptRows).toBe(1000);

    await second.background.remove(c, finished.id);
    await expect(second.background.get(c, finished.id)).rejects.toThrow(/no longer exists/);
    await second.background.clearFinished(c);
    expect(await second.background.list(c)).toEqual([]);
  });

  it("describes time and titles for people", () => {
    expect(errorSummary("Msg 208, Level 16, State 1, Line 1\nInvalid object name 'x'.\nLine 1")).toBe("Invalid object name 'x'.");
    expect(errorSummary('ERROR:  relation "t" does not exist\nLine 1')).toBe('ERROR:  relation "t" does not exist');
    expect(formatElapsed(420)).toBe("420 ms");
    expect(formatElapsed(3200)).toBe("3.2 s");
    expect(formatElapsed(133_000)).toBe("2m 13s");
    expect(formatElapsed(3_900_000)).toBe("1h 05m");
    expect(titleOf("\n-- hi\n  SELECT   a,\n b FROM t")).toBe("SELECT a, b FROM t");
    expect(titleOf("x".repeat(200))).toHaveLength(70);
    expect(oneLine("# c\n  UPDATE t   SET a = 1", 12)).toBe("UPDATE t SE…");
    const base = { id: "i", connectionId: "c", title: "t", sql: "s", database: null, startedAt: new Date(2026, 9, 25, 14, 3).getTime(), elapsedMs: 133_000, rows: 1234, resultSets: 1, hasErrors: false };
    expect(describeTask({ ...base, state: "running" })).toBe("running · since 14:03");
    expect(describeTask({ ...base, state: "done" })).toBe("done · 2m 13s · 1,234 rows · 14:03");
    expect(describeTask({ ...base, state: "interrupted" })).toBe("interrupted · 14:03");
    const now = new Date(2026, 9, 25, 12).getTime();
    expect(dayLabel(now, now)).toBe("Today");
    expect(dayLabel(now - 86_400_000, now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 20, 9).getTime(), now)).toBe("Tue 20 Oct");
  });
});

describe("the QUERY HISTORY and BACKGROUND TASKS sections", () => {
  it("groups history by day, newest first, and each entry reopens its query in its own tab", async () => {
    const history = createHistoryStore("sections-test");
    const c = "sec-c1";
    const day = 86_400_000;
    // Entries are stamped now; shift a couple back by rewriting `at` through the file's own format.
    await history.record(c, { sql: "SELECT 1", database: "shop", status: "ok", elapsedMs: 4, rows: 1 });
    await history.record(c, { sql: "UPDATE t SET a = 1\nWHERE b = 2", database: null, status: "error", elapsedMs: 9, rows: 0, error: "boom" });
    const section = createHistorySection("x", history, createQueryWindowFactory("x"));
    expect(combineSections([section]).handles("x.historyGroup")).toBe(true); // nodes that have children; entries are leaves

    const root = await section.nodes(c, { id: "r", label: "c", nodeType: "x.historyRoot", collapsible: "expanded" });
    expect(root.map((g) => [g.label, g.description, g.collapsible])).toEqual([["Today", "2", "expanded"]]);
    const entries = await section.nodes(c, root[0]!);
    expect(entries.map((e) => [e.label, e.icon])).toEqual([["UPDATE t SET a = 1 WHERE b = 2", "$(close)"], ["SELECT 1", "$(file-code)"]]); // newest first; failed ones marked
    expect(entries[1]).toMatchObject({ nodeType: "x.historyEntry", contextValue: "x.historyEntry", data: { database: "shop" } });
    expect(entries[1]!.openView).toMatchObject({ viewId: "x.query", params: { sql: "SELECT 1", database: "shop", windowId: expect.stringMatching(/^hist:/) } });
    expect(entries[0]!.tooltip).toContain("— boom");
    void day;

    expect(await section.nodes("sec-empty", { id: "r", label: "c", nodeType: "x.historyRoot", collapsible: "expanded" })).toMatchObject([{ nodeType: "x.historyHint" }]);
  });

  it("lists background tasks with their state, and offers Cancel only on running ones", async () => {
    const db = fakeDb();
    const host = fakeHost();
    const background = createBackground({ productName: "T", host, store: createBackgroundStore("sections-bg"), executeQuery: db.executeQuery, cancelQuery: db.cancelQuery, describeError: String });
    const c = "sec-c2";
    const a = await background.start({ connectionId: c, sql: "SELECT slow" });
    const b = await background.start({ connectionId: c, sql: "SELECT quick" });
    await tick();
    [...db.pending.values()][1]!.resolve(run());
    await tick();
    await tick();
    const section = createBackgroundSection("x", background);
    const nodes = await section.nodes(c, { id: "r", label: "c", nodeType: "x.backgroundRoot", collapsible: "expanded" });
    const byTitle = Object.fromEntries(nodes.map((n) => [n.label, n]));
    expect(byTitle["SELECT slow"]).toMatchObject({ contextValue: "x.backgroundTaskRunning", icon: "$(refresh)", data: { backgroundId: a.id } });
    expect(byTitle["SELECT quick"]).toMatchObject({ contextValue: "x.backgroundTask", icon: "$(results)", data: { backgroundId: b.id } });
    expect(byTitle["SELECT quick"]!.description).toMatch(/^done · .* · 3 rows · \d\d:\d\d$/);
    expect(byTitle["SELECT slow"]!.openView).toMatchObject({ viewId: "x.backgroundTask", params: { id: a.id } });
    expect(await section.nodes("sec-none", { id: "r", label: "c", nodeType: "x.backgroundRoot", collapsible: "expanded" })).toMatchObject([{ nodeType: "x.backgroundHint" }]);
  });
});
