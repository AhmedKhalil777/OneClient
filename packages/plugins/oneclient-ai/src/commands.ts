import type { CommandHandler } from "@oneclient/plugin-api";
import { store, validId } from "./store.js";

type Args = { connectionId?: string; conversationId?: string; name?: string };
type Outcome = { ok: true } | { ok: false; error: string };

/** Context-menu commands on conversations (declared with `when` clauses in the manifest). */
export function createCommandHandlers(): CommandHandler[] {
  const on = (commandId: string, fn: (connectionId: string, id: string, a: Args) => void): CommandHandler => ({
    commandId,
    execute: (args): Outcome => {
      const a = (args[0] ?? {}) as Args;
      try {
        if (!a.connectionId || !validId(a.conversationId)) throw new Error("Missing conversation.");
        fn(a.connectionId, a.conversationId, a);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  return [
    on("ai.deleteConversation", (c, id) => store.delete(c, id)),
    on("ai.renameConversation", (c, id, a) => store.rename(c, id, String(a.name ?? ""))),
  ];
}
