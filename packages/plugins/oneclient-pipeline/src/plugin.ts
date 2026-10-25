import type { CommandHandler, ConnectionProvider, ExplorerProvider, TreeNode, ViewMessageHandler } from "@oneclient/plugin-api";
import type { Pipeline } from "./model.js";
import type { PipelineService } from "./service.js";
import { dropStore, storeFor } from "./store.js";

const EDITOR = "pipeline.editor";
const ICON = "$(play)";

const openPipeline = (p: { id: string; name: string }): TreeNode => ({
  id: p.id,
  label: p.name,
  nodeType: "pipeline.editorTab",
  collapsible: "none",
  openView: { viewId: EDITOR, title: p.name, icon: ICON, params: { id: p.id } },
});

export function createConnectionProvider(): ConnectionProvider {
  return {
    typeId: "pipeline",
    configSchema: { type: "object", properties: {} },
    async connect(_config, ctx) {
      if (!ctx.connectionId) throw new Error("connect() requires a saved connection.");
      storeFor(ctx.connectionId); // loads the file; throws a clear error if it is from a newer version
      return { id: ctx.connectionId, typeId: "pipeline", state: {} };
    },
    async test() {
      return { success: true, message: "Ready — a pipeline workspace needs no server." };
    },
    async disconnect(_handle, ctx) {
      if (ctx.connectionId) dropStore(ctx.connectionId);
    },
  };
}

const STATUS_MARK = { passed: "✓", failed: "✗", cancelled: "■" } as const;

export function createExplorerProvider(service: PipelineService): ExplorerProvider {
  return {
    nodeTypes: ["pipeline.pipeline"],
    async getChildren(node, ctx): Promise<TreeNode[]> {
      if (node) return [];
      return service.list(ctx.connectionId).map((p) => ({
        id: p.id,
        label: p.name,
        description: p.running ? "running…" : p.lastRun ? `${STATUS_MARK[p.lastRun.status]} ${p.lastRun.status}` : `${p.steps} step${p.steps === 1 ? "" : "s"}`,
        tooltip: p.description || p.name,
        nodeType: "pipeline.pipeline",
        collapsible: "none" as const,
        icon: ICON,
        contextValue: "pipeline.pipeline",
        data: { pipelineId: p.id },
        openView: { viewId: EDITOR, title: p.name, icon: ICON, params: { id: p.id } },
      }));
    },
  };
}

interface Args {
  connectionId: string;
  pipelineId?: string;
  name?: string;
  [key: string]: unknown;
}

type Outcome = { ok: true; openNode?: TreeNode; message?: string } | { ok: false; error: string };

/** Context-menu commands, plus `pipeline.api` — the single command the editor view talks to. */
export function createCommandHandlers(service: PipelineService): CommandHandler[] {
  const on = (commandId: string, fn: (a: Args) => Promise<Outcome>): CommandHandler => ({
    commandId,
    execute: async (args) => {
      try {
        return await fn((args[0] ?? {}) as Args);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Outcome;
      }
    },
  });
  const need = (a: Args): string => {
    if (!a.pipelineId) throw new Error("Missing pipeline.");
    return a.pipelineId;
  };

  return [
    {
      commandId: "pipeline.api",
      async execute(args) {
        const a = (args[0] ?? {}) as { connectionId?: string; method?: string; params?: Record<string, unknown> };
        try {
          return { ok: true, data: await api(service, a.connectionId ?? "", String(a.method ?? ""), a.params ?? {}) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    on("pipeline.new", async (a) => {
      const p = await service.create(a.connectionId, String(a.name ?? ""));
      return { ok: true, openNode: openPipeline(p) };
    }),
    on("pipeline.newExample", async (a) => {
      const p = await service.create(a.connectionId, "", true);
      return { ok: true, openNode: openPipeline(p) };
    }),
    on("pipeline.run", async (a) => {
      await service.start(a.connectionId, need(a));
      return { ok: true, message: "Started — progress is in the Tasks panel." };
    }),
    on("pipeline.duplicate", async (a) => {
      await service.duplicate(a.connectionId, need(a));
      return { ok: true };
    }),
    on("pipeline.delete", async (a) => {
      await service.remove(a.connectionId, need(a));
      return { ok: true };
    }),
  ];
}

async function api(service: PipelineService, connectionId: string, method: string, p: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "get":
      return { pipeline: service.get(connectionId, String(p.id)), runs: service.runs(connectionId, String(p.id)), active: service.activeRuns(connectionId).filter((r) => r.pipelineId === p.id) };
    case "save":
      return service.save(connectionId, p.pipeline as Pipeline);
    case "run":
      return service.start(connectionId, String(p.id), (p.overrides as Record<string, string> | undefined) ?? {});
    case "cancel":
      service.cancel(String(p.runId));
      return {};
    case "dockerConnections":
      return service.dockerConnections();
    case "tools":
      return service.tools();
    default:
      throw new Error(`Unknown pipeline API method “${method}”.`);
  }
}

/** Streams run events to every open editor of a connection. */
export function createEditorViewHandler(service: PipelineService): ViewMessageHandler {
  return {
    onMessage(message, ctx) {
      const msg = message as { type?: string };
      if (msg.type === "subscribe" && ctx.connectionId) service.subscribe(ctx.connectionId, (event) => ctx.reply({ type: "run", event }));
    },
  };
}
