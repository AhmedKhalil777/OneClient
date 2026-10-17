import { type BlobConnectionConfig, BlobPluginError, type ServiceHandle, buildService } from "./client.js";

const sessions = new Map<string, ServiceHandle>();

export function openSession(connectionId: string, config: BlobConnectionConfig): ServiceHandle {
  const handle = buildService(config);
  sessions.set(connectionId, handle);
  return handle;
}

export const closeSession = (connectionId: string): void => void sessions.delete(connectionId);
export const closeAll = (): void => sessions.clear();

export function requireSession(connectionId: string | undefined): ServiceHandle {
  if (!connectionId) throw new BlobPluginError("No connection id provided.");
  const s = sessions.get(connectionId);
  if (!s) throw new BlobPluginError("Not connected — expand the connection in the explorer to reconnect.");
  return s;
}
