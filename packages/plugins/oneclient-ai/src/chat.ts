import type { PluginContext, ViewMessageContext, ViewMessageHandler } from "@oneclient/plugin-api";
import { type AgentEvent, STOP_NOTES, runAgent } from "./agent.js";
import { MODELS, modelRef, providerFor, splitModelRef } from "./presets.js";
import { loadPluginTools } from "./plugin-tools.js";
import { describeError } from "./providers/index.js";
import { modelTable, providerOf, sessionFor } from "./sessions.js";
import { exportMarkdown, store, titleFrom, transcript, validId } from "./store.js";
import type { Conversation, ToolCall } from "./types.js";

/** An answer that took this long is worth a notification: the user has probably switched to something else. */
const NOTIFY_AFTER_MS = 8000;

const BASE_PROMPT = [
  "You are an AI assistant built into oneClient, a desktop and web developer console (databases, files, APIs, containers, queues).",
  "Be direct and concise. When you change files, make the smallest edit that does the job and explain it in a sentence.",
  "You can look at the folders the user has open with your file tools; read before you edit, and never claim to have changed something you have not.",
  "For anything involving a database or another service in the app, call list_connections, then use that service's tools (for SQL: look at the schema first, query read-only, and only change data through the execute tool, which the user approves).",
].join(" ");

interface Run {
  abort: AbortController;
  reply: (message: unknown) => void;
  pending: Map<string, { call: ToolCall; summary: string; resolve: (allow: boolean) => void }>;
}

const runs = new Map<string, Run>();
const key = (connectionId: string, c: string) => `${connectionId}\u0000${c}`;

/** The model a conversation uses: its own pick, else the connection's default, else the first Claude model. */
function modelOf(conv: Conversation, defaultModel: unknown): { provider: string; model: string } {
  if (conv.provider && conv.model) return { provider: conv.provider, model: conv.model };
  const d = typeof defaultModel === "string" ? splitModelRef(defaultModel) : undefined;
  return d ?? { provider: MODELS[0]!.provider, model: MODELS[0]!.id };
}

/** The chat tab: one registered handler serves every open conversation; each message names its conversation (`c`). */
export function createChatHandler(context: PluginContext): ViewMessageHandler {
  const handleInit = (connectionId: string, c: string, ctx: ViewMessageContext) => {
    const { config } = sessionFor(connectionId);
    const conv = store.open(connectionId, c);
    const run = runs.get(key(connectionId, c));
    if (run) {
      run.reply = (m) => ctx.reply(m);
      for (const [id, p] of run.pending) ctx.reply({ type: "approval", c, id, name: p.call.name, summary: p.summary });
    }
    const m = modelOf(conv, config.defaultModel);
    ctx.reply({
      type: "init",
      c,
      title: conv.title,
      items: transcript(conv.messages),
      usage: conv.usage,
      model: modelRef(m.provider, m.model),
      workspaceTools: config.workspaceTools !== false,
      running: Boolean(run),
    });
  };

  const handleSend = async (connectionId: string, c: string, text: string, picked: string | undefined, ctx: ViewMessageContext) => {
    const k = key(connectionId, c);
    if (runs.has(k)) return ctx.reply({ type: "error", c, message: "Still working on the previous message." });
    const session = sessionFor(connectionId);
    const { config } = session;
    const conv: Conversation = store.open(connectionId, c);
    const isNew = conv.messages.length === 0;
    const ref = picked ? splitModelRef(picked) : undefined;
    if (ref) Object.assign(conv, { provider: ref.provider, model: ref.model });
    const { provider: providerId, model } = modelOf(conv, config.defaultModel);
    const provider = providerFor(providerId);
    if (!provider || !model) return ctx.reply({ type: "error", c, message: "Pick a model first." });
    let client;
    try {
      client = providerOf(session, providerId);
    } catch (err) {
      return ctx.reply({ type: "error", c, message: describeError(err) });
    }
    if (isNew) conv.title = titleFrom(text);
    conv.messages.push({ role: "user", text });
    store.save(connectionId, conv);
    if (isNew) context.refreshExplorer(connectionId);

    const startedAt = Date.now();
    const run: Run = { abort: new AbortController(), reply: (m) => ctx.reply(m), pending: new Map() };
    runs.set(k, run);
    run.reply({ type: "running", c, running: true });
    const emit = (event: AgentEvent) => run.reply({ type: "event", c, event });

    try {
      const stop = await runAgent(conv, {
        provider: client,
        model,
        system: [BASE_PROMPT, typeof config.systemPrompt === "string" ? config.systemPrompt.trim() : ""].filter(Boolean).join("\n\n"),
        effort: provider.kind === "anthropic" && typeof config.effort === "string" && config.effort ? config.effort : undefined,
        maxTokens: Number(config.maxTokens) > 0 ? Number(config.maxTokens) : provider.kind === "anthropic" ? 32000 : 8192,
        workspaceTools: config.workspaceTools !== false,
        plugins: config.pluginTools === false ? undefined : await loadPluginTools(context),
        signal: run.abort.signal,
        emit,
        persist: () => store.save(connectionId, conv),
        host: {
          folders: async () => (await context.workspace.getFolders()).map((f) => ({ name: f.name, path: f.path })),
          approve: (call, summary) =>
            new Promise<boolean>((resolve) => {
              if (run.abort.signal.aborted) return resolve(false);
              run.pending.set(call.id, { call, summary, resolve });
              run.reply({ type: "approval", c, id: call.id, name: call.name, summary });
              // The agent is stuck until the user answers — say so, in case the chat tab isn't in front.
              void context.notifications.warning(`The assistant needs your approval: ${call.name}`, { detail: summary, key: `approval:${call.id}` }).catch(() => undefined);
            }),
        },
      });
      const note = STOP_NOTES[stop];
      if (note) run.reply({ type: "note", c, text: note });
      if (Date.now() - startedAt >= NOTIFY_AFTER_MS && !run.abort.signal.aborted) {
        void context.notifications
          .success(note ? `Assistant stopped: ${conv.title || "chat"}` : `Assistant finished: ${conv.title || "chat"}`, { ...(note ? { detail: note } : {}), key: `done:${k}` })
          .catch(() => undefined);
      }
    } catch (err) {
      // Keep the conversation consistent: a user message with no answer is fine, a dangling tool call is not.
      const last = conv.messages[conv.messages.length - 1];
      if (last?.role === "assistant" && last.calls.length) {
        conv.messages.push({ role: "tool", results: last.calls.map((call) => ({ id: call.id, name: call.name, content: "Interrupted.", isError: true })) });
      }
      store.save(connectionId, conv);
      run.reply({ type: "error", c, message: run.abort.signal.aborted ? "Stopped." : describeError(err) });
      if (!run.abort.signal.aborted) {
        void context.notifications.error(`The assistant hit an error: ${conv.title || "chat"}`, { detail: describeError(err), key: `done:${k}` }).catch(() => undefined);
      }
    } finally {
      for (const p of run.pending.values()) p.resolve(false);
      runs.delete(k);
      run.reply({ type: "running", c, running: false });
      context.refreshExplorer(connectionId);
    }
  };

  return {
    async onMessage(message, ctx) {
      const m = (message ?? {}) as { type?: string; c?: string; text?: string; model?: string; id?: string; allow?: boolean; refresh?: boolean };
      const connectionId = ctx.connectionId;
      try {
        if (!connectionId) throw new Error("This view needs a connection.");
        if (m.type === "models") return ctx.reply({ type: "models", rows: await modelTable(sessionFor(connectionId), m.refresh === true) });
        if (m.type === "list") {
          const running = new Set([...runs.keys()].filter((k) => k.startsWith(`${connectionId}\u0000`)).map((k) => k.split("\u0000")[1]));
          return ctx.reply({ type: "list", items: store.list(connectionId).map((c) => ({ ...c, running: running.has(c.id) })) });
        }
        if (!validId(m.c)) throw new Error("Missing conversation id.");
        if (m.type === "init") return handleInit(connectionId, m.c, ctx);
        if (m.type === "rename" && typeof m.text === "string") {
          store.rename(connectionId, m.c, m.text);
          context.refreshExplorer(connectionId);
          return ctx.reply({ type: "list", items: store.list(connectionId) });
        }
        if (m.type === "delete") {
          runs.get(key(connectionId, m.c))?.abort.abort();
          store.delete(connectionId, m.c);
          context.refreshExplorer(connectionId);
          return ctx.reply({ type: "list", items: store.list(connectionId) });
        }
        if (m.type === "export") {
          const conv = store.get(connectionId, m.c);
          return ctx.reply({ type: "export", c: m.c, title: conv?.title ?? "conversation", markdown: conv ? exportMarkdown(conv) : "" });
        }
        if (m.type === "send" && typeof m.text === "string" && m.text.trim()) return void (await handleSend(connectionId, m.c, m.text.trim(), m.model, ctx));
        const run = runs.get(key(connectionId, m.c));
        if (m.type === "stop") run?.abort.abort();
        if (m.type === "approve" && m.id) {
          const p = run?.pending.get(m.id);
          if (p) {
            run?.pending.delete(m.id);
            p.resolve(m.allow === true);
            void context.notifications.dismiss(`${context.pluginId}:approval:${m.id}`).catch(() => undefined);
          }
        }
      } catch (err) {
        ctx.reply({ type: "error", c: m.c, message: describeError(err) });
      }
    },
  };
}
