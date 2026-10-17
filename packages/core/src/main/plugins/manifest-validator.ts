import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { PluginManifest } from "@oneclient/plugin-api";

// electron-vite externalizes deps for the main build, so this resolves via
// normal Node `require` against @oneclient/plugin-api's package exports.
const require = createRequire(import.meta.url);
const schema = require("@oneclient/plugin-api/schema/oneclient-manifest.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

export interface ManifestValidationResult {
  valid: boolean;
  manifest?: PluginManifest;
  errors?: string[];
}

export function validateManifest(data: unknown): ManifestValidationResult {
  const valid = validateSchema(data);
  if (!valid) {
    const errors = (validateSchema.errors ?? []).map(
      (e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`,
    );
    return { valid: false, errors };
  }
  return { valid: true, manifest: data as PluginManifest };
}
