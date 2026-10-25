/**
 * Minimal structural typing for the subset of JSON Schema (draft 2020-12)
 * that oneClient's Tier 1 form/grid renderer understands.
 *
 * We deliberately hand-roll this instead of depending on `json-schema` /
 * `@types/json-schema` so the plugin-api package has zero runtime
 * dependencies and a tiny, auditable type surface. Widen this if Tier 1
 * forms need more of the spec (e.g. `oneOf`, `$ref`) in a later phase.
 */
export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface JsonSchemaObject {
  type?: JsonSchemaType | JsonSchemaType[];
  title?: string;
  description?: string;
  default?: unknown;
  /** Tier 1 forms show the first example as an input placeholder. */
  examples?: unknown[];
  enum?: unknown[];
  const?: unknown;
  /** Standard formats pass through; oneClient also understands `"directory"` and `"file"` (Tier 1 forms add a native folder / file picker). */
  format?: string;
  /** With `format: "file"`: file extensions (no dot) the picker offers first, e.g. ["csv", "tsv"]. */
  "x-file-extensions"?: string[];
  /** oneClient-specific hint, not standard JSON Schema: render as a secret/password input and route through SecretStore. */
  "x-secret"?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  items?: JsonSchemaObject;
  additionalProperties?: boolean | JsonSchemaObject;
}

/**
 * Optional UI layout hints for a Tier 1 form, keyed by property name.
 * Deliberately separate from the JSON Schema itself (same split
 * react-jsonschema-form uses) so the schema stays pure data validation.
 */
export interface UiSchema {
  [propertyName: string]:
    | {
        "ui:widget"?: "text" | "password" | "select" | "textarea" | "toggle" | "number";
        "ui:order"?: number;
        "ui:help"?: string;
      }
    | UiSchema;
}
