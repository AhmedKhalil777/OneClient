import { type Provider, keyField, providerFor } from "../presets.js";
import type { AiConfig, ChatProvider } from "../types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAiProvider } from "./openai.js";

/** The API key the user entered for a provider (empty = none). */
export function keyFor(config: AiConfig, providerId: string): string {
  const v = config[keyField(providerId)];
  return typeof v === "string" ? v.trim() : "";
}

/** The address a provider is reached at: Ollama and Custom come from the config, the rest are fixed (or a proxy override). */
export function baseUrlFor(config: AiConfig, provider: Provider): string | undefined {
  if (provider.id === "ollama") return config.ollamaUrl?.trim() || provider.baseUrl;
  if (provider.id === "custom") return config.customUrl?.trim() || undefined;
  return provider.baseUrl;
}

/** Whether a provider can be used right now with this config (has a key, or needs none). */
export function isReady(config: AiConfig, provider: Provider): boolean {
  if (provider.id === "anthropic") return Boolean(keyFor(config, "anthropic") || process.env.ANTHROPIC_API_KEY);
  if (provider.id === "custom") return Boolean(config.customUrl?.trim());
  return provider.keyOptional ? true : Boolean(keyFor(config, provider.id));
}

export function createProvider(config: AiConfig, providerId: string): ChatProvider {
  const provider = providerFor(providerId);
  if (!provider) throw new Error(`Unknown provider "${providerId}".`);
  const apiKey = keyFor(config, providerId) || undefined;
  if (provider.kind === "anthropic") return createAnthropicProvider(apiKey, undefined);
  const baseUrl = baseUrlFor(config, provider);
  if (!baseUrl) throw new Error(`${provider.label} needs a server address in the connection settings.`);
  if (!apiKey && !provider.keyOptional) throw new Error(`${provider.label} has no API key yet. Add it in the connection settings${provider.keyUrl ? ` (create one at ${provider.keyUrl})` : ""}.`);
  return createOpenAiProvider({ apiKey, baseUrl, completionTokens: provider.completionTokens ?? false });
}

/** A readable one-line message for whatever an SDK threw (bad key, quota, unknown model, network…). */
export function describeError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { status?: number; message?: string; name?: string; error?: { message?: string } };
    if (e.name === "AbortError" || e.name === "APIUserAbortError") return "Stopped.";
    const detail = e.error?.message ?? e.message ?? String(err);
    if (e.status === 401 || e.status === 403) return `The API key was rejected (${e.status}). ${detail}`;
    if (e.status === 404) return `Not found (404) — the provider doesn't know this model id. Pick another from the list. ${detail}`;
    if (e.status === 429) return `Rate limited or out of quota (429). ${detail}`;
    if (e.status) return `${e.status}: ${detail}`;
    return detail;
  }
  return String(err);
}
