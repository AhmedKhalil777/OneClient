import { randomUUID } from "node:crypto";

/**
 * Variables: `{{name}}`, `{{steps.<id>.<output>}}`, `{{name:-fallback}}`, and the built-ins `{{$guid}}`, `{{$timestamp}}`
 * (unix seconds), `{{$random}}` (8 hex digits). Double braces, because single `${…}` is shell syntax (PowerShell, bash) and
 * scripts must reach the shell untouched. A placeholder that resolves to nothing is an error, not an empty
 * string — a test that silently talks to `http://:/` is worse than one that stops.
 */
export type Vars = Record<string, string>;

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

export class UndefinedVariable extends Error {
  constructor(readonly variable: string) {
    super(`Undefined variable {{${variable}}}.`);
    this.name = "UndefinedVariable";
  }
}

function builtin(name: string): string | undefined {
  switch (name) {
    case "$guid":
      return randomUUID();
    case "$timestamp":
      return String(Math.floor(Date.now() / 1000));
    case "$random":
      return randomUUID().slice(0, 8);
    default:
      return undefined;
  }
}

export function interpolate(text: string, vars: Vars): string {
  return text.replace(PLACEHOLDER, (_m, expr: string) => {
    const fallback = expr.indexOf(":-");
    const key = (fallback >= 0 ? expr.slice(0, fallback) : expr).trim();
    const value = key.startsWith("$") ? builtin(key) : vars[key];
    if (value !== undefined) return value;
    if (fallback >= 0) return expr.slice(fallback + 2);
    throw new UndefinedVariable(key);
  });
}

/** Interpolates every string inside a JSON-like value (objects and arrays are copied). */
export function deepInterpolate<T>(value: T, vars: Vars): T {
  if (typeof value === "string") return interpolate(value, vars) as T;
  if (Array.isArray(value)) return value.map((v) => deepInterpolate(v, vars)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepInterpolate(v, vars)])) as T;
  return value;
}

/** Replaces secret values in text with `***`, for logs. */
export function mask(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) if (s.length >= 3) out = out.split(s).join("***");
  return out;
}

/** `a.b[0].c` or `$.a.b` against parsed JSON; undefined when any segment is missing. */
export function jsonPath(data: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, "").match(/[^.[\]]+/g) ?? [];
  let cur: unknown = data;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** A value as text: strings as-is, everything else as JSON. */
export function stringify(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}
