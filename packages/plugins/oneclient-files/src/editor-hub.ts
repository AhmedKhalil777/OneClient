import type { ViewMessageHandler } from "@oneclient/plugin-api";

/** "Show this line in the editor": sent by the Search view, delivered to whichever editor tab has that file. */
export interface RevealRequest {
  path: string;
  line: number;
  col: number;
  length: number;
}

type Reply = (message: unknown) => void;

const replies = new Map<string, Reply>();
const pending = new Map<string, { at: number; reveal: RevealRequest }>();
const PENDING_MS = 15_000;

const keyOf = (connectionId: string, path: string) => `${connectionId}\u0000${path}`;

/**
 * Hub between the Search view and the file editors. A reply reaches every editor tab of the connection, so each
 * message carries its file `path` and an editor only reacts to its own. A tab that is still opening says "hello"
 * when it has loaded, and gets the request that was waiting for it.
 */
export function createEditorViewHandler(): ViewMessageHandler {
  return {
    onMessage(message, ctx) {
      const msg = message as { type?: string; path?: string };
      if (msg.type !== "hello" || typeof msg.path !== "string" || !ctx.connectionId) return;
      replies.set(ctx.connectionId, ctx.reply);
      const key = keyOf(ctx.connectionId, msg.path);
      const waiting = pending.get(key);
      if (waiting && Date.now() - waiting.at < PENDING_MS) ctx.reply({ type: "reveal", ...waiting.reveal });
      pending.delete(key);
    },
  };
}

export function reveal(connectionId: string, request: RevealRequest): void {
  pending.set(keyOf(connectionId, request.path), { at: Date.now(), reveal: request });
  replies.get(connectionId)?.({ type: "reveal", ...request });
}
