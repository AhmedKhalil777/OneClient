import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const schemaPath = join(here, "..", "schema", "oneclient-manifest.schema.json");

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

const schema = loadJson(schemaPath);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema as object);

function validManifest(fixture: string) {
  const data = loadJson(join(fixturesDir, fixture));
  const valid = validate(data);
  return { valid, errors: validate.errors };
}

describe("oneclient-manifest.schema.json", () => {
  it("accepts a well-formed Tier 1 manifest (oneclient-postgres)", () => {
    const { valid, errors } = validManifest("valid-postgres.oneclient.json");
    expect(errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it("accepts a well-formed Tier 2 manifest with a matching `ui` + `entry` (oneclient-kafka)", () => {
    const { valid, errors } = validManifest("valid-kafka-tier2.oneclient.json");
    expect(errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it("accepts theme, icon theme and icon contributions", () => {
    const manifest = {
      name: "oneclient-theme-pack",
      version: "1.0.0",
      engines: { oneclient: "^0.1.0" },
      main: "dist/main.js",
      contributes: {
        themes: [{ id: "solarized", label: "Solarized Dark", uiTheme: "dark", path: "themes/solarized.json" }],
        iconThemes: [{ id: "filled", label: "Filled Icons", path: "icons/theme.json" }],
        icons: [{ id: "docker-container", description: "A container", path: "icons/container.svg", colored: true }],
      },
    };
    expect(validate(manifest)).toBe(true);
  });

  it("rejects an unknown theme kind and a malformed icon id", () => {
    const base = { name: "oneclient-x", version: "1.0.0", engines: { oneclient: "^0.1.0" }, main: "m.js" };
    expect(validate({ ...base, contributes: { themes: [{ id: "t", label: "T", uiTheme: "sepia", path: "t.json" }] } })).toBe(false);
    expect(validate({ ...base, contributes: { icons: [{ id: "Bad Id", path: "a.svg" }] } })).toBe(false);
  });

  it("rejects a manifest missing `engines`", () => {
    const { valid, errors } = validManifest("invalid-missing-engines.oneclient.json");
    expect(valid).toBe(false);
    expect(errors?.some((e) => e.message?.includes("engines"))).toBe(true);
  });

  it("rejects a Tier 2 view when the top-level `ui` bundle path is missing", () => {
    const { valid } = validManifest("invalid-tier2-missing-ui.oneclient.json");
    expect(valid).toBe(false);
  });

  it("rejects a Tier 2 view contribution missing `entry`", () => {
    const { valid } = validManifest("invalid-tier2-missing-entry.oneclient.json");
    expect(valid).toBe(false);
  });

  it("rejects an invalid plugin name and non-semver version together", () => {
    const { valid, errors } = validManifest("invalid-bad-name-and-version.oneclient.json");
    expect(valid).toBe(false);
    expect(errors && errors.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects unknown top-level fields (e.g. a speculative `permissions` key)", () => {
    const { valid } = validManifest("invalid-unknown-top-level-field.oneclient.json");
    expect(valid).toBe(false);
  });
});
