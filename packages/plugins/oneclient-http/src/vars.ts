import { randomInt, randomUUID } from "node:crypto";
import type { Collection, KV, Workspace } from "./model.js";

/** `{{name}}` placeholders, as in Postman. */
const PLACEHOLDER = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;

export type Scope = Map<string, string>;

/**
 * Variables in effect for a request: the collection's, overridden by the active environment's
 * (only enabled entries count; later duplicates win).
 */
export function buildScope(ws: Workspace, collection?: Collection, environmentId: string | undefined = ws.activeEnvironmentId): Scope {
  const scope: Scope = new Map();
  const add = (vars: KV[]) => {
    for (const v of vars) if (v.enabled && v.key) scope.set(v.key, v.value);
  };
  if (collection) add(collection.variables);
  const env = ws.environments.find((e) => e.id === environmentId);
  if (env) add(env.variables);
  return scope;
}

function dynamicValue(name: string): string | undefined {
  switch (name) {
    case "$guid":
    case "$randomUUID":
      return randomUUID();
    case "$timestamp":
      return String(Math.floor(Date.now() / 1000));
    case "$isoTimestamp":
      return new Date().toISOString();
    case "$randomInt":
      return String(randomInt(0, 1001));
    default:
      return undefined;
  }
}

export interface Interpolated {
  text: string;
  /** Names that had no value (left as written in `text`). */
  unresolved: string[];
}

export function interpolate(text: string, scope: Scope, unresolved: Set<string> = new Set()): Interpolated {
  const out = text.replace(PLACEHOLDER, (whole, name: string) => {
    const hit = scope.get(name) ?? dynamicValue(name);
    if (hit === undefined) {
      unresolved.add(name);
      return whole;
    }
    return hit;
  });
  return { text: out, unresolved: [...unresolved] };
}

/** Names of all `{{placeholders}}` in the text. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}
