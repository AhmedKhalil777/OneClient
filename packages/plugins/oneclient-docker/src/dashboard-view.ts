import type { ViewMessageHandler } from "@oneclient/plugin-api";
import { describeDockerError } from "./errors.js";
import { requireSession } from "./sessions.js";

/**
 * Backend half of the Tier 2 dashboard. One handler instance serves every
 * open dashboard tab (see ViewMessageContext docs in plugin-api) — the
 * `connectionId` on each incoming message tells us which one.
 *
 * Container/image listing and start/stop/restart/remove/pull go through
 * ordinary contributed commands (see commands.ts) via
 * `ViewHostApi.invokeCommand` — that's a plain request/response, no need
 * for this handler. Log tailing is the one thing that genuinely needs a
 * push channel (new lines arrive whenever the container writes them, not
 * on a fixed request/response cadence), which is exactly what `reply`
 * being callable repeatedly and asynchronously is for.
 */
export function createDashboardViewHandler(): ViewMessageHandler {
  const logStreams = new Map<string, NodeJS.ReadableStream>();

  return {
    async onMessage(message, ctx) {
      const msg = message as { type: string; containerId?: string };

      if (msg.type === "tailLogs" && msg.containerId) {
        stopTail(ctx.connectionId);
        try {
          const client = requireSession(ctx.connectionId);
          const stream = (await client.getContainer(msg.containerId).logs({
            follow: true,
            stdout: true,
            stderr: true,
            tail: 200,
          })) as unknown as NodeJS.ReadableStream;

          if (ctx.connectionId) logStreams.set(ctx.connectionId, stream);

          stream.on("data", (chunk: Buffer) => {
            ctx.reply({ type: "logLine", containerId: msg.containerId, text: demuxChunk(chunk) });
          });
          stream.on("error", (err: Error) => {
            ctx.reply({ type: "logError", containerId: msg.containerId, error: describeDockerError(err) });
          });
          stream.on("end", () => {
            ctx.reply({ type: "logEnd", containerId: msg.containerId });
          });
        } catch (err) {
          ctx.reply({ type: "logError", containerId: msg.containerId, error: describeDockerError(err) });
        }
        return;
      }

      if (msg.type === "stopTailLogs") {
        stopTail(ctx.connectionId);
      }
    },

    onDispose(connectionId) {
      stopTail(connectionId);
    },
  };

  function stopTail(connectionId: string | undefined): void {
    if (!connectionId) return;
    const stream = logStreams.get(connectionId);
    if (stream && "destroy" in stream && typeof stream.destroy === "function") {
      stream.destroy();
    }
    logStreams.delete(connectionId);
  }
}

/**
 * Docker's non-TTY log stream multiplexes stdout/stderr behind an 8-byte
 * header per frame (type, 3 reserved bytes, 4-byte big-endian length) —
 * strip it so the UI gets plain text. Falls back to raw text if a chunk
 * doesn't look like the framed format (e.g. a TTY-attached container).
 */
function demuxChunk(chunk: Buffer): string {
  let out = "";
  let offset = 0;
  while (offset + 8 <= chunk.length) {
    const type = chunk[offset];
    if (type !== 0 && type !== 1 && type !== 2) break;
    const length = chunk.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > chunk.length) break;
    out += chunk.toString("utf-8", start, end);
    offset = end;
  }
  if (offset < chunk.length) out += chunk.toString("utf-8", offset);
  return out;
}
