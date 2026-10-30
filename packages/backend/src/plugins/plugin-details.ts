import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginDetails } from "../shared/types.js";
import { type PluginRecord, summarizePlugin } from "./plugin-manager.js";

const KIND_LABELS: Record<string, string> = {
  commands: "Commands",
  views: "Views",
  connectionTypes: "Connection types",
  explorerNodes: "Explorer nodes",
  explorerSections: "Explorer sections",
  themes: "Color themes",
  iconThemes: "Icon themes",
  searchProviders: "Search providers",
  menus: "Menus",
  quickActions: "Quick actions",
  icons: "Icons",
};

/** What a plugin's manifest adds to the app, by kind — the "Contributions" tab of the plugin page. */
export function describeContributions(contributes: object | undefined): NonNullable<PluginDetails["contributions"]> {
  const out: NonNullable<PluginDetails["contributions"]> = [];
  for (const [key, value] of Object.entries(contributes ?? {})) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const items = (value as Array<Record<string, unknown>>)
      .filter((v) => v && typeof v === "object" && v["hidden"] !== true)
      .map((v) => {
        const id = String(v["id"] ?? v["name"] ?? "");
        const title = [v["title"], v["label"], v["displayName"]].find((t): t is string => typeof t === "string");
        const description = typeof v["description"] === "string" ? v["description"] : undefined;
        return { id, ...(title ? { title } : {}), ...(description ? { description } : {}) };
      })
      .filter((i) => i.id);
    if (items.length) out.push({ kind: KIND_LABELS[key] ?? key, items });
  }
  return out;
}

/** The plugin page for an installed plugin: its manifest, README and contributions. */
export async function installedPluginDetails(record: PluginRecord): Promise<PluginDetails> {
  const m = record.manifest;
  const summary = summarizePlugin(record);
  let readme: string | undefined;
  try {
    readme = await readFile(join(record.rootDir, "README.md"), "utf-8");
  } catch {
    /* a plugin without a README just shows its description */
  }
  return {
    id: record.id,
    version: summary.version,
    installed: true,
    state: record.state,
    ...(record.error ? { error: record.error } : {}),
    ...(record.removable ? { removable: true } : {}),
    ...(m?.displayName ? { displayName: m.displayName } : {}),
    ...(m?.description ? { description: m.description } : {}),
    ...(m?.publisher ? { publisher: m.publisher } : {}),
    ...(m?.license ? { license: m.license } : {}),
    ...(m?.repository ? { repository: m.repository } : {}),
    ...(m?.engines?.oneclient ? { engine: m.engines.oneclient } : {}),
    ...(m?.icon ? { icon: m.icon } : {}),
    ...(readme ? { readme } : {}),
    ...(summary.features ? { features: summary.features } : {}),
    contributions: describeContributions(m?.contributes),
  };
}
