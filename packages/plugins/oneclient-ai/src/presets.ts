/**
 * The providers and the model table. One connection holds an API key per provider; the chat's model picker lists
 * every model below (plus whatever your keys can actually use) so switching model never means adding a connection.
 *
 * Everything except Claude speaks the OpenAI chat-completions protocol, so one adapter serves all the others.
 * Base URLs, model ids and prices are best-effort and drift over time: the picker merges in the real model list
 * from each provider, and prices are shown as approximate ("≈").
 */
export interface Provider {
  id: string;
  label: string;
  kind: "anthropic" | "openai";
  baseUrl?: string;
  /** Where to create a key. */
  keyUrl?: string;
  /** Local servers need no key. */
  keyOptional?: boolean;
  /** Sends `max_completion_tokens` instead of `max_tokens` (OpenAI's newer models reject the old name). */
  completionTokens?: boolean;
}

export interface ModelRow {
  provider: string;
  id: string;
  label: string;
  /** $ per 1M tokens, approximate; absent when I could not find a reliable figure. */
  priceIn?: number;
  priceOut?: number;
}

export const PROVIDERS: readonly Provider[] = [
  { id: "anthropic", label: "Claude (Anthropic)", kind: "anthropic", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys", completionTokens: true },
  { id: "gemini", label: "Google Gemini", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "deepseek", label: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "kimi", label: "Kimi (Moonshot)", kind: "openai", baseUrl: "https://api.moonshot.ai/v1", keyUrl: "https://platform.moonshot.ai/console/api-keys" },
  { id: "glm", label: "GLM (Z.ai)", kind: "openai", baseUrl: "https://api.z.ai/api/paas/v4/", keyUrl: "https://z.ai/manage-apikey/apikey-list" },
  { id: "grok", label: "Grok (xAI)", kind: "openai", baseUrl: "https://api.x.ai/v1", keyUrl: "https://console.x.ai" },
  { id: "mistral", label: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys" },
  { id: "qwen", label: "Qwen (Alibaba)", kind: "openai", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyUrl: "https://bailian.console.alibabacloud.com" },
  { id: "openrouter", label: "OpenRouter (any model)", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys" },
  { id: "ollama", label: "Ollama (local)", kind: "openai", baseUrl: "http://localhost:11434/v1", keyOptional: true },
  { id: "custom", label: "Custom server", kind: "openai", keyOptional: true },
];

export const MODELS: readonly ModelRow[] = [
  { provider: "anthropic", id: "claude-opus-5-5", label: "Claude Opus 5.5", priceIn: 4, priceOut: 20 },
  { provider: "anthropic", id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", priceIn: 2, priceOut: 10 },
  { provider: "anthropic", id: "claude-haiku-5-5", label: "Claude Haiku 5.5", priceIn: 0.1, priceOut: 0.5 },
  { provider: "anthropic", id: "claude-fable-5-1", label: "Claude Fable 5.1", priceIn: 10, priceOut: 50 },
  { provider: "openai", id: "gpt-5.5", label: "GPT-5.5" },
  { provider: "openai", id: "gpt-5.6-sol", label: "GPT-5.6 Sol", priceIn: 5, priceOut: 30 },
  { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra", priceIn: 2, priceOut: 12 },
  { provider: "openai", id: "gpt-5.6-luna", label: "GPT-5.6 Luna", priceIn: 0.2, priceOut: 1.2 },
  { provider: "gemini", id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", priceIn: 2, priceOut: 12 },
  { provider: "gemini", id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", priceIn: 1.5, priceOut: 9 },
  { provider: "deepseek", id: "deepseek-chat", label: "DeepSeek chat", priceIn: 0.14, priceOut: 0.28 },
  { provider: "deepseek", id: "deepseek-reasoner", label: "DeepSeek reasoner" },
  { provider: "kimi", id: "kimi-k2-0905-preview", label: "Kimi K2 0905", priceIn: 0.6, priceOut: 2.5 },
  { provider: "kimi", id: "kimi-k2-thinking", label: "Kimi K2 Thinking", priceIn: 0.47, priceOut: 2 },
  { provider: "glm", id: "glm-5.2", label: "GLM-5.2", priceIn: 1.4, priceOut: 4.4 },
  { provider: "grok", id: "grok-4.5", label: "Grok 4.5", priceIn: 2, priceOut: 6 },
  { provider: "mistral", id: "mistral-large-latest", label: "Mistral Large", priceIn: 0.5, priceOut: 1.5 },
  { provider: "qwen", id: "qwen3-max", label: "Qwen3 Max" },
];

export const providerFor = (id: string | undefined): Provider | undefined => PROVIDERS.find((p) => p.id === id);

/** The config field that holds a provider's API key: `anthropicKey`, `openaiKey`… */
export const keyField = (providerId: string): string => `${providerId}Key`;

/** A model is addressed everywhere as `provider/model-id` (model ids may themselves contain slashes, e.g. OpenRouter's). */
export function splitModelRef(ref: string): { provider: string; model: string } | undefined {
  const i = ref.indexOf("/");
  if (i <= 0) return undefined;
  const provider = ref.slice(0, i);
  return providerFor(provider) ? { provider, model: ref.slice(i + 1) } : undefined;
}
export const modelRef = (provider: string, model: string) => `${provider}/${model}`;
