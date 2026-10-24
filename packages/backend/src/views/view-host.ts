import type { OpenViewRequest } from "@oneclient/plugin-api";
import type { WorkbenchShortcut } from "../shared/ipc-contract.js";

export interface OpenViewOptions {
  instanceId: string;
  pluginId: string;
  viewId: string;
  connectionId?: string | undefined;
  params?: Record<string, string> | undefined;
  /** A plugin view: its page inside the plugin's ui bundle. */
  entryDir?: string;
  entryFile?: string;
  /** A core view: its page in core's renderer build, e.g. "views/editor/index.html". */
  corePage?: string;
}

export interface ViewInstanceInfo {
  pluginId: string;
  viewId: string;
  connectionId?: string | undefined;
}

export type OpenFileHandler = (path: string, options: { line?: number | undefined; column?: number | undefined; length?: number | undefined }) => Promise<void>;

/**
 * Where Tier 2 view instances live:
 *  - desktop: native WebContentsViews over the window (ViewHostManager);
 *  - web: iframes in the browser tab that opened them (server/remote-view-host.ts).
 * The backend only uses this interface: open/close instances, push messages to them, and hear what they ask for.
 */
export interface ViewHost {
  /** `caller` is who asked (an RpcHost caller). The result goes back to the shell (the web returns the iframe's URL). */
  open(opts: OpenViewOptions, caller: unknown): unknown;
  /** `caller` scopes the id to that shell (in the web, two browser tabs can use the same instance ids). */
  close(instanceId: string, caller?: unknown): void;
  closeAll(): void;
  getInstance(instanceId: string, caller?: unknown): ViewInstanceInfo | undefined;
  /** An instance went away — closed by the shell, or its browser tab disconnected. */
  onInstanceClosed(listener: (instance: ViewInstanceInfo) => void): () => void;
  /** Whether any instance of `viewId` is open (in any window or browser tab). */
  hasInstance(viewId: string): boolean;
  /** To every open instance of `viewId` scoped to `connectionId`. */
  push(viewId: string, connectionId: string | undefined, message: unknown): void;
  broadcastTheme(state: unknown): void;

  setOpenFileHandler(handler: OpenFileHandler): void;
  onDirtyChanged(listener: (instanceId: string, dirty: boolean) => void): () => void;
  onShortcut(listener: (shortcut: WorkbenchShortcut) => void): () => void;
  onReveal(listener: (pluginId: string, viewId: string) => void): () => void;
  onRefreshExplorer(listener: (connectionId: string) => void): () => void;
  onOpenView(listener: (pluginId: string, connectionId: string | undefined, request: OpenViewRequest) => void): () => void;
}

/** A message from a view to its backend (its plugin's extension host, or a core service). */
export type MessageFromViewFn = (pluginId: string, viewId: string, connectionId: string | undefined, message: unknown) => void;
