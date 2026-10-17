import type { ConnectionTypeContribution } from "@oneclient/plugin-api";

export interface ConnectionLabel {
  /** "Server" */
  one: string;
  /** "Servers" */
  many: string;
}

const DEFAULT: ConnectionLabel = { one: "Connection", many: "Connections" };

/**
 * What a plugin calls its saved connections ("Folder", "Server", "Cluster"…), from its connection types'
 * `connectionLabel`. Types that disagree (or none declared) fall back to "Connection".
 */
export function connectionLabel(types: readonly ConnectionTypeContribution[]): ConnectionLabel {
  const labels = types.map((t) => (t.connectionLabel ? { one: t.connectionLabel, many: t.connectionLabelPlural ?? `${t.connectionLabel}s` } : DEFAULT));
  const first = labels[0];
  if (!first || labels.some((l) => l.one !== first.one)) return DEFAULT;
  return first;
}
