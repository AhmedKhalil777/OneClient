import type { JsonSchemaObject } from "./json-schema.js";

/**
 * Letting the AI assistant work with your plugin (`oneclient.aiTools`).
 *
 * A plugin lists the things an assistant may do in its manifest, each backed by one of its own commands:
 *
 *   "contributes": {
 *     "commands": [{ "id": "postgres.ai.query", "title": "AI: Run read-only query", "hidden": true }],
 *     "extensions": {
 *       "oneclient.aiTools": [{
 *         "name": "postgres_query",
 *         "description": "Run one read-only SQL statement on a PostgreSQL connection and get the rows.",
 *         "command": "postgres.ai.query",
 *         "readOnly": true,
 *         "inputSchema": { "type": "object", "required": ["connectionId", "sql"], "properties": { … } }
 *       }]
 *     }
 *   }
 *
 * The AI assistant plugin offers every listed tool to the model and runs them through `context.aiTools.call`. The
 * command receives the model's arguments as its first argument and returns `{ ok: true, text }` or
 * `{ ok: false, error }` (any other value is shown as JSON). Tools that are not `readOnly` make the assistant ask
 * the user before each call. Models learn connection ids from the assistant's `list_connections` tool, so tools
 * for a connection take a `connectionId` property.
 */
export const AI_TOOLS_POINT = "oneclient.aiTools";

export interface AiToolContribution {
  /** What the model calls it: letters, digits, `_` and `-`, at most 48 characters. Prefix it with your plugin ("postgres_query"). */
  readonly name: string;
  /** Tell the model when to use it and what it returns — this is its only documentation. */
  readonly description: string;
  /** The contributing plugin's command that runs it. */
  readonly command: string;
  readonly inputSchema: JsonSchemaObject;
  /** True: only reads, runs without asking. Default false: the user approves each call. */
  readonly readOnly?: boolean;
}

/** Calls a tool's command. Only commands listed in some plugin's `oneclient.aiTools` can be called this way. */
export interface AiTools {
  call(commandId: string, input: Record<string, unknown>): Promise<unknown>;
}
