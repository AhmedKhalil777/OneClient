import type { WebSocket } from "ws";
import type { RpcHost } from "@oneclient/backend/rpc/rpc-host.js";
import type { ClientMessage, ServerMessage, ViewEventKind } from "@oneclient/backend/shared/web-protocol.js";

let nextClientId = 1;

/** One browser tab: its WebSocket. Handlers receive it as their `caller`. */
export class WebClient {
  readonly id = `c${nextClientId++}`;
  constructor(private readonly socket: WebSocket) {}

  send(message: ServerMessage): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

type Handler = (caller: unknown, ...args: unknown[]) => unknown;
export type ViewEventHandler = (client: WebClient, instanceId: string, kind: ViewEventKind, payload: unknown) => void;

/**
 * RpcHost over WebSockets: what Electron IPC is to the desktop app. Request/response calls, fire-and-forget sends and
 * broadcasts to every connected tab; view events go to the view host.
 */
export class WsRpc implements RpcHost {
  private readonly handlers = new Map<string, Handler>();
  private readonly listeners = new Map<string, Handler>();
  private readonly clients = new Set<WebClient>();
  private readonly disconnectListeners = new Set<(client: WebClient) => void>();
  private viewEvents: ViewEventHandler | undefined;

  handle(channel: string, handler: Handler): void {
    if (this.handlers.has(channel)) throw new Error(`Handler for "${channel}" registered twice.`);
    this.handlers.set(channel, handler);
  }

  on(channel: string, handler: Handler): void {
    this.listeners.set(channel, handler);
  }

  broadcast(channel: string, payload: unknown): void {
    const frame: ServerMessage = { t: "event", ch: channel, payload };
    for (const client of this.clients) client.send(frame);
  }

  setViewEventHandler(handler: ViewEventHandler): void {
    this.viewEvents = handler;
  }

  onDisconnect(listener: (client: WebClient) => void): void {
    this.disconnectListeners.add(listener);
  }

  /** A browser tab connected (already authenticated by the server). */
  attach(socket: WebSocket): void {
    const client = new WebClient(socket);
    this.clients.add(client);
    // Keep idle connections open through proxies; drop dead ones.
    let alive = true;
    socket.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30_000);

    socket.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return;
      }
      void this.dispatch(client, msg);
    });
    socket.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(client);
      for (const listener of this.disconnectListeners) listener(client);
    });
  }

  private async dispatch(client: WebClient, msg: ClientMessage): Promise<void> {
    switch (msg.t) {
      case "call": {
        const handler = this.handlers.get(msg.ch);
        try {
          if (!handler) throw new Error(`No handler for "${msg.ch}".`);
          const value = await handler(client, ...(Array.isArray(msg.args) ? msg.args : []));
          client.send({ t: "result", id: msg.id, ok: true, value });
        } catch (err) {
          client.send({ t: "result", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      case "send":
        try {
          await this.listeners.get(msg.ch)?.(client, ...(Array.isArray(msg.args) ? msg.args : []));
        } catch (err) {
          console.error(`[web] ${msg.ch}:`, err);
        }
        return;
      case "view":
        if (typeof msg.inst === "string") this.viewEvents?.(client, msg.inst, msg.kind, msg.payload);
        return;
    }
  }
}
