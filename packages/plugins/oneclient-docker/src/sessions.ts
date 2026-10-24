import type Docker from "dockerode";

/**
 * One Docker Engine client per live connectionId. Module-level singleton is
 * safe here because each plugin gets its own dedicated extension-host
 * process (see ARCHITECTURE.md) — there's exactly one of these per plugin
 * instance, not shared across plugins or processes.
 */
export const sessions = new Map<string, Docker>();

/** Where a connection's published ports are reachable: 127.0.0.1 for the local engine, else the remote host's name. */
const hosts = new Map<string, string>();

export function setSession(connectionId: string, client: Docker, host: string): void {
  sessions.set(connectionId, client);
  hosts.set(connectionId, host);
}

export function dropSession(connectionId: string): void {
  sessions.delete(connectionId);
  hosts.delete(connectionId);
}

export function hostAddress(connectionId: string): string {
  return hosts.get(connectionId) ?? "127.0.0.1";
}

export function requireSession(connectionId: string | undefined): Docker {
  if (!connectionId) throw new Error("No connection id provided.");
  const client = sessions.get(connectionId);
  if (!client) throw new Error("Not connected to Docker — open or reconnect this connection first.");
  return client;
}
