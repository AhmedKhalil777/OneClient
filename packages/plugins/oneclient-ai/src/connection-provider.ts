import type { ConnectionProvider, JsonSchemaObject } from "@oneclient/plugin-api";
import { PROVIDERS, keyField } from "./presets.js";
import { createProvider, describeError, isReady } from "./providers/index.js";
import { closeSession, openSession } from "./sessions.js";
import type { AiConfig } from "./types.js";

const keyProps = (): Record<string, JsonSchemaObject> =>
  Object.fromEntries(
    PROVIDERS.filter((p) => !p.keyOptional || p.id === "custom").map((p) => [
      keyField(p.id),
      {
        type: "string",
        title: `${p.label} — API key`,
        "x-secret": true,
        ...(p.keyUrl ? { description: `Create one at ${p.keyUrl}${p.id === "anthropic" ? ". Empty = use ANTHROPIC_API_KEY or an “ant auth login” profile." : ""}` } : {}),
      } satisfies JsonSchemaObject,
    ]),
  );

/**
 * One AI connection for everything: paste the keys of the providers you use (leave the rest empty) and pick any of
 * their models from the chat's model table. Only providers with a key (or none needed) are offered.
 */
export function createConnectionProvider(): ConnectionProvider<AiConfig> {
  return {
    typeId: "ai",
    configSchema: {
      type: "object",
      properties: {
        ...keyProps(),
        ollamaUrl: { type: "string", title: "Ollama address (local models)", default: "http://localhost:11434/v1", description: "Models you have pulled into Ollama show up in the model table. Empty = default address." },
        customUrl: { type: "string", title: "Custom server address", description: "Any OpenAI-compatible server (LM Studio, vLLM, a company gateway…), e.g. http://localhost:1234/v1. Its key goes in “Custom server — API key”." },
        defaultModel: { type: "string", title: "Default model", default: "anthropic/claude-sonnet-5-5", description: "Where new conversations start, as provider/model. You can switch model in any chat." },
        effort: { type: "string", title: "Claude thinking effort", enum: ["", "low", "medium", "high"], default: "", description: "Empty = the model's default. Lower is cheaper and faster." },
        systemPrompt: { type: "string", title: "System prompt (optional)", description: "Added to every conversation, e.g. “Answer briefly. We use PostgreSQL and TypeScript.”" },
        maxTokens: { type: "number", title: "Max reply length in tokens (optional)", minimum: 256, description: "Empty = 32000 for Claude, 8192 for the others (some providers reject more)." },
        pluginTools: { type: "boolean", title: "Let the assistant use my other connections (SQL databases…)", default: true, description: "Plugins such as PostgreSQL, SQL Server and MySQL offer tools: list tables, run read-only queries. Anything that changes data waits for your approval. Turn off to keep the assistant away from your databases." },
        workspaceTools: { type: "boolean", title: "Let the assistant read my open folders and propose edits", default: true, description: "It can list, read and search files in folders open in the Explorer. Every edit waits for your approval. Turn off for plain chat." },
      },
    },

    async connect(config, ctx) {
      if (!ctx.connectionId) throw new Error("connect() requires a saved connection.");
      openSession(ctx.connectionId, config);
      return { id: ctx.connectionId, typeId: "ai", state: {} };
    },

    async test(config, ctx) {
      const started = Date.now();
      const ready = PROVIDERS.filter((p) => isReady(config, p) && (p.id === "anthropic" ? Boolean(config[keyField("anthropic")]) : !p.keyOptional || p.id === "custom"));
      if (!ready.length) return { success: false, message: "Add at least one API key — for example your Claude, OpenAI, Gemini or DeepSeek key." };
      const lines = await Promise.all(
        ready.map(async (p) => {
          try {
            const ids = await createProvider(config, p.id).listModels(ctx.signal);
            return { ok: true, text: `${p.label}: ${ids.length} models` };
          } catch (err) {
            return { ok: false, text: `${p.label}: ${describeError(err)}` };
          }
        }),
      );
      const failed = lines.filter((l) => !l.ok);
      return {
        success: failed.length === 0,
        message: lines.map((l) => `${l.ok ? "✓" : "✗"} ${l.text}`).join("\n"),
        latencyMs: Date.now() - started,
      };
    },

    async disconnect(_handle, ctx) {
      if (ctx.connectionId) closeSession(ctx.connectionId);
    },
  };
}
