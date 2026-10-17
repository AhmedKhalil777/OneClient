import type Docker from "dockerode";

/**
 * One Docker Engine client per live connectionId. Module-level singleton is
 * safe here because each plugin gets its own dedicated extension-host
 * process (see ARCHITECTURE.md) — there's exactly one of these per plugin
 * instance, not shared across plugins or processes.
 */
export const sessions = new Map<string, Docker>();

export function requireSession(connectionId: string | undefined): Docker {
  if (!connectionId) throw new Error("No connection id provided.");
  const client = sessions.get(connectionId);
  if (!client) throw new Error("Not connected to Docker — open or reconnect this connection first.");
  return client;
}
