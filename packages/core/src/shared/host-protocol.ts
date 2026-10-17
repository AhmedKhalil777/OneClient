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
  | { type: "secret:ack"; requestId: string };

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
  | { type: "secret:get"; requestId: string; key: string }
  | { type: "secret:set"; requestId: string; key: string; value: string }
  | { type: "secret:delete"; requestId: string; key: string }
  | { type: "deactivated" };
