/**
 * How the shell (and Tier 2 views) talk to the backend, independent of the runtime:
 *  - desktop: Electron IPC (electron-rpc.ts) — `caller` is the IpcMainInvokeEvent;
 *  - web server: one WebSocket per browser tab (server/ws-rpc.ts) — `caller` is that tab's client.
 * Handlers that don't care who called just ignore `caller`.
 */
export interface RpcHost {
  /** Request/response: the return value (or thrown error) goes back to the caller. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, handler: (caller: unknown, ...args: any[]) => unknown): void;
  /** Fire-and-forget messages. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(channel: string, handler: (caller: unknown, ...args: any[]) => void): void;
  /** An event to every connected shell (every window / browser tab). */
  broadcast(channel: string, payload: unknown): void;
}
