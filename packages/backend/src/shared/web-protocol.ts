/**
 * The web runtime's WebSocket protocol (one socket per browser tab, JSON text frames) between the browser bridge
 * (workbench/src/web/bridge.ts) and the server (server/src/ws-rpc.ts). The desktop app uses Electron IPC instead.
 */

/** Path of the WebSocket endpoint. */
export const WS_PATH = "/__oneclient/ws";
/** The script the server injects into every view page (gives it `window.oneclientView`). */
export const VIEW_BRIDGE_PATH = "/__oneclient/view.js";
/** Assets (icons, plugin files): `/asset/<host>/<path>`, like `oneclient-asset://<host>/<path>` on the desktop. */
export const ASSET_PREFIX = "/asset/";
/** Plugin view pages: `/plugin-ui/<pluginId>/<path inside its ui folder>`. */
export const PLUGIN_UI_PREFIX = "/plugin-ui/";

/** What a view instance tells its backend (`window.oneclientView` calls that aren't request/response). */
export type ViewEventKind = "post" | "dirty" | "reveal" | "open-view" | "refresh-explorer";

export type ClientMessage =
  /** Request/response: an RpcHost handler. */
  | { t: "call"; id: number; ch: string; args: unknown[] }
  /** Fire-and-forget: an RpcHost `on` handler. */
  | { t: "send"; ch: string; args: unknown[] }
  /** From one of this tab's view instances. */
  | { t: "view"; inst: string; kind: ViewEventKind; payload?: unknown };

export type ServerMessage =
  | { t: "result"; id: number; ok: true; value?: unknown }
  | { t: "result"; id: number; ok: false; error: string }
  /** A broadcast event (the desktop's `webContents.send`). */
  | { t: "event"; ch: string; payload: unknown }
  /** To one of this tab's view instances: a plugin's `reply` / push. */
  | { t: "view"; inst: string; payload: unknown };
