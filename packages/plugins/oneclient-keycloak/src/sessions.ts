import { type KeycloakClient, type KeycloakConnectionConfig } from "./client.js";

/** One signed-in client per saved connection (each plugin runs in its own extension-host process, so this is per-plugin state). */
const clients = new Map<string, KeycloakClient>();

export function setClient(connectionId: string, client: KeycloakClient): void {
  clients.set(connectionId, client);
}

export function dropClient(connectionId: string): void {
  clients.delete(connectionId);
}

export function dropAll(): void {
  clients.clear();
}

export function requireClient(connectionId: string | undefined): KeycloakClient {
  if (!connectionId) throw new Error("No connection id provided.");
  const client = clients.get(connectionId);
  if (!client) throw new Error("Not connected to Keycloak — expand the connection in the explorer to reconnect.");
  return client;
}

export type { KeycloakConnectionConfig };
