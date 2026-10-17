import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import * as pty from "node-pty";
import { type ShellProfile, detectProfiles } from "./profiles.js";

/** Messages pushed to the terminal view. */
export type ToView =
  | { type: "state"; profiles: Array<Pick<ShellProfile, "id" | "name">>; sessions: SessionInfo[] }
  | { type: "created"; session: SessionInfo; focus: boolean }
  | { type: "data"; id: string; data: string }
  | { type: "exit"; id: string; code: number };

export interface SessionInfo {
  id: string;
  title: string;
  profileId: string;
  cwd: string;
  /** Recent output, so a reloaded view can redraw the screen. */
  replay?: string;
}

interface Session {
  info: SessionInfo;
  pty: pty.IPty;
  replay: string;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const REPLAY_LIMIT = 200_000; // chars of scrollback kept for view reloads
const FLUSH_MS = 8; // batch tiny pty chunks into one IPC message

const sessions = new Map<string, Session>();
let profiles: ShellProfile[] | null = null;
let send: ((message: ToView) => void) | null = null;
let counter = 0;

export function getProfiles(): ShellProfile[] {
  return (profiles ??= detectProfiles());
}

/** The view's push channel (its latest `reply`); output produced before a view exists is kept in `replay`. */
export function setSender(fn: ((message: ToView) => void) | null): void {
  send = fn;
}

export function state(): ToView {
  return {
    type: "state",
    profiles: getProfiles().map(({ id, name }) => ({ id, name })),
    sessions: [...sessions.values()].map((s) => ({ ...s.info, replay: s.replay })),
  };
}

/** Accepts a directory or a file (opens in its folder); falls back to the home directory. */
function resolveCwd(path: string | undefined): string {
  if (path && existsSync(path)) {
    try {
      return statSync(path).isDirectory() ? path : dirname(path);
    } catch {
      /* fall through */
    }
  }
  return homedir();
}

export function createSession(opts: {
  profileId?: string | undefined;
  cwd?: string | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  focus?: boolean;
}): SessionInfo {
  const all = getProfiles();
  const profile = all.find((p) => p.id === opts.profileId) ?? all[0];
  if (!profile) throw new Error("No shell found on this machine.");
  const cwd = resolveCwd(opts.cwd);
  const id = `t${++counter}-${Date.now().toString(36)}`;

  const proc = pty.spawn(profile.file, profile.args, {
    name: "xterm-256color",
    cols: Math.max(2, opts.cols ?? 80),
    rows: Math.max(1, opts.rows ?? 24),
    cwd,
    env: { ...process.env, TERM_PROGRAM: "oneClient", COLORTERM: "truecolor" } as Record<string, string>,
    useConpty: true,
  });

  const sameProfile = [...sessions.values()].filter((s) => s.info.profileId === profile.id).length;
  const info: SessionInfo = { id, title: sameProfile ? `${profile.name} (${sameProfile + 1})` : profile.name, profileId: profile.id, cwd };
  const session: Session = { info, pty: proc, replay: "", pending: "", flushTimer: null };
  sessions.set(id, session);

  proc.onData((data) => {
    session.replay = (session.replay + data).slice(-REPLAY_LIMIT);
    session.pending += data;
    session.flushTimer ??= setTimeout(() => {
      session.flushTimer = null;
      const chunk = session.pending;
      session.pending = "";
      send?.({ type: "data", id, data: chunk });
    }, FLUSH_MS);
  });
  proc.onExit(({ exitCode }) => {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    if (session.pending) send?.({ type: "data", id, data: session.pending });
    sessions.delete(id);
    send?.({ type: "exit", id, code: exitCode });
  });

  send?.({ type: "created", session: info, focus: opts.focus ?? true });
  return info;
}

export function write(id: string, data: string): void {
  sessions.get(id)?.pty.write(data);
}

export function resize(id: string, cols: number, rows: number): void {
  const s = sessions.get(id);
  if (!s || cols < 2 || rows < 1) return;
  try {
    s.pty.resize(Math.floor(cols), Math.floor(rows));
  } catch {
    /* the process may have just exited */
  }
}

export function kill(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.pty.kill();
  } catch {
    sessions.delete(id);
  }
}

export function killAll(): void {
  for (const id of [...sessions.keys()]) kill(id);
}
