/**
 * Message envelope for main <-> extension-host communication over
 * Electron's `utilityProcess` port (`process.parentPort` on the child
 * side). Internal-only — plugin authors never see this; it's what the
 * extension-host runtime (bootstrap.ts) speaks on a plugin's behalf.
 */

export type InvokeKind = "connection" | "explorer" | "command";

export type HostInboundMessage =
  | { type: "activate"; pluginId: string; extensionPath: string; mainPath: string }
  | {
      type: "invoke";
      requestId: string;
      kind: InvokeKind;
      target: string;
      method: string;
      args: unknown[];
      connectionId?: string;
    }
  | { type: "deactivate" }
  | { type: "secret:result"; requestId: string; value?: string }
  | { type: "secret:ack"; requestId: string }
  | { type: "view:message"; viewId: string; connectionId?: string; message: unknown }
  | { type: "view:dispose"; viewId: string; connectionId?: string }
  | { type: "workspace:result"; requestId: string; ok: true; value?: unknown }
  | { type: "workspace:result"; requestId: string; ok: false; error: string }
  | { type: "workspace:changed"; folders: Array<{ name: string; path: string }> }
  | { type: "task:cancel"; taskId: string };

export type RegisteredContribution =
  | { kind: "connection"; typeId: string; configSchema: unknown; uiSchema?: unknown }
  | { kind: "explorer"; nodeTypes: string[] }
  | { kind: "command"; commandId: string }
  | { kind: "view"; viewId: string };

export type HostOutboundMessage =
  | { type: "activated" }
  | { type: "activate:error"; error: string }
  | { type: "registered"; contribution: RegisteredContribution }
  | { type: "invoke:result"; requestId: string; ok: true; result: unknown }
  | { type: "invoke:result"; requestId: string; ok: false; error: string }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; meta?: unknown }
  | { type: "output"; channel: string; level: "debug" | "info" | "warn" | "error"; message: string; detail?: string; time: number }
  | { type: "output:clear"; channel: string }
  | { type: "output:show"; channel: string }
  | { type: "secret:get"; requestId: string; key: string }
  | { type: "secret:set"; requestId: string; key: string; value: string }
  | { type: "secret:delete"; requestId: string; key: string }
  | { type: "deactivated" }
  | { type: "view:push"; viewId: string; connectionId?: string; message: unknown }
  | { type: "workspace:folders"; requestId: string }
  | { type: "task:start"; taskId: string; title: string; cancellable: boolean }
  | { type: "task:update"; taskId: string; log?: string; detail?: string; progress?: number }
  | { type: "task:end"; taskId: string; ok: boolean; error?: string }
  | { type: "workspace:openFile"; requestId: string; path: string; options?: { line?: number; column?: number; length?: number } };
