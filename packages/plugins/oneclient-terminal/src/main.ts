import type { PluginContext, ViewMessageHandler } from "@oneclient/plugin-api";
import { createSession, kill, killAll, resize, setSender, state, write } from "./sessions.js";

type FromView =
  | { type: "hello" }
  | { type: "create"; profileId?: string; cols?: number; rows?: number }
  | { type: "input"; id: string; data: string }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "kill"; id: string };

/**
 * The panel view talks to the shells over the view message channel: input,
 * resize and kill go up; output, exit and new sessions are pushed down via
 * `reply`. Shells live here (in the extension host), so they keep running
 * while the panel is hidden, and a reloaded view gets a replay of recent output.
 */
function createViewHandler(): ViewMessageHandler {
  return {
    onMessage(message, ctx) {
      const msg = message as FromView;
      switch (msg.type) {
        case "hello":
          setSender((m) => ctx.reply(m));
          ctx.reply(state());
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
    },
    onDispose() {
      // The view went away (window reload/close); shells stay alive and replay into the next view.
      setSender(null);
    },
  };
}

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-terminal activated");
  context.subscriptions.push(context.registerView("terminal.panel", createViewHandler()));

  // "Open in Terminal" on Files explorer folders/files: args[0] carries the node's data (incl. fsPath).
  context.subscriptions.push(
    context.registerCommand({
      commandId: "terminal.openAt",
      execute(args) {
        const { fsPath } = (args[0] ?? {}) as { fsPath?: string };
        try {
          createSession(fsPath ? { cwd: fsPath } : {});
          return { ok: true, revealView: "terminal.panel" };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  );
}

export function deactivate(): void {
  killAll();
}
