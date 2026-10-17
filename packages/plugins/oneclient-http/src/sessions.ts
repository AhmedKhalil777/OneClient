/** Per-connection settings, remembered when the connection is opened (one extension host serves every HTTP connection). */
export interface HttpConnectionConfig {
  timeoutSeconds?: number;
  followRedirects?: boolean;
  allowSelfSignedCertificate?: boolean;
}

const sessions = new Map<string, HttpConnectionConfig>();

export const setSession = (connectionId: string, config: HttpConnectionConfig): void => void sessions.set(connectionId, config);
export const dropSession = (connectionId: string): void => void sessions.delete(connectionId);
export const dropAllSessions = (): void => sessions.clear();

export function sessionFor(connectionId: string | undefined): HttpConnectionConfig {
  // Not connected yet (e.g. a restored tab) — fall back to defaults rather than failing.
  return (connectionId && sessions.get(connectionId)) || {};
}
