import { createSession, kill, killAll, resize, sendAction, setSender, state, write } from "./sessions.js";

/**
 * The terminal's own process (a `utilityProcess` started by core's TerminalService). The shells (node-pty, a native
 * module) live here, so a misbehaving shell or pty can't take the window down, and they keep running while the
 * Terminal panel is hidden.
 */

/** From main: the panel view's messages, and the Terminal menu's commands. */
export type TerminalHostInbound =
  | { type: "view"; message: FromView }
  | { type: "viewGone" }
  | { type: "command"; requestId: string; command: "new" | "kill" | "clear"; cwd?: string }
  | { type: "shutdown" };

/** To main: messages for the panel view, and command results. */
export type TerminalHostOutbound = { type: "push"; message: unknown } | { type: "result"; requestId: string; ok: true } | { type: "result"; requestId: string; ok: false; error: string };

type FromView =
  | { type: "hello" }
  | { type: "create"; profileId?: string; cols?: number; rows?: number }
  | { type: "input"; id: string; data: string }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "kill"; id: string };

const post = (message: TerminalHostOutbound) => process.parentPort.postMessage(message);

process.parentPort.on("message", (e) => {
  const msg = e.data as TerminalHostInbound;
  switch (msg.type) {
    case "view":
      onView(msg.message);
      return;
    case "viewGone":
      // The panel went away (window reload / close): shells stay alive and replay into the next view.
      setSender(null);
      return;
    case "command":
      try {
        if (msg.command === "new") createSession(msg.cwd ? { cwd: msg.cwd } : {});
        else sendAction(msg.command);
        post({ type: "result", requestId: msg.requestId, ok: true });
      } catch (err) {
        post({ type: "result", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    case "shutdown":
      killAll();
      process.exit(0);
  }
});

function onView(msg: FromView) {
  switch (msg.type) {
    case "hello":
      setSender((m) => post({ type: "push", message: m }));
      post({ type: "push", message: state() });
      return;
    case "create":
      createSession({ profileId: msg.profileId, cols: msg.cols, rows: msg.rows });
      return;
    case "input":
      write(msg.id, msg.data);
      return;
    case "resize":
      resize(msg.id, msg.cols, msg.rows);
      return;
    case "kill":
      kill(msg.id);
  }
}
