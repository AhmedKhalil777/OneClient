/** The provider-neutral conversation model. Every provider adapter converts to and from these. */

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the arguments (an object schema). */
  schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type Msg =
  | { role: "user"; text: string }
  /**
   * `raw` is what the provider needs to see again to continue the turn faithfully (Claude's thinking blocks,
   * a reasoning model's `reasoning_content`). It is only meaningful to the adapter that produced it.
   */
  | { role: "assistant"; text: string; calls: ToolCall[]; raw?: unknown; model?: string }
  | { role: "tool"; results: ToolResult[] };

export interface Usage {
  input: number;
  output: number;
  /** Input tokens served from the provider's cache, when it reports them. */
  cached?: number;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface TurnRequest {
  model: string;
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  maxTokens: number;
  /** low | medium | high — honoured by providers that have a reasoning-effort control. */
  effort?: string | undefined;
  signal: AbortSignal;
}

export interface TurnHandlers {
  onText(delta: string): void;
  onThinking(delta: string): void;
}

export interface TurnResult {
  text: string;
  calls: ToolCall[];
  raw?: unknown;
  usage: Usage;
  stop: StopReason;
}

export interface ChatProvider {
  /** Model ids the key can use (used to validate a connection and to fill the model picker). */
  listModels(signal?: AbortSignal): Promise<string[]>;
  /** One model turn, streamed. Throws on transport / API errors; the caller shows `describeError`. */
  turn(request: TurnRequest, handlers: TurnHandlers): Promise<TurnResult>;
}

/**
 * One connection holds an API key per provider (`anthropicKey`, `openaiKey`, … — see presets.ts `keyField`), so the
 * chat can use any model without a connection per model.
 */
export type AiConfig = {
  /** `provider/model` that new conversations start with. */
  defaultModel?: string;
  /** Ollama's address, if not the default. */
  ollamaUrl?: string;
  /** A custom OpenAI-compatible server's address. */
  customUrl?: string;
  effort?: string;
  systemPrompt?: string;
  /** Longest reply, in tokens. Empty = 32000 for Claude, 8192 elsewhere (some providers cap lower). */
  maxTokens?: number;
  workspaceTools?: boolean;
  [key: string]: unknown;
};

export interface Conversation {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Model picked for this conversation (`provider` + model id); falls back to the connection's default. */
  provider?: string;
  model?: string;
  messages: Msg[];
  usage: Usage;
}
