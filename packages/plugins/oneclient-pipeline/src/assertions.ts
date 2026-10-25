import type { Assertion, AssertionResult } from "./model.js";
import { jsonPath, stringify, type Vars } from "./vars.js";

/** What a step produced, for assertions to look at. Every field is optional: a shell step has no status. */
export interface Subject {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  durationMs?: number;
  exitCode?: number;
  output?: string;
  vars: Vars;
}

/** The value an assertion looks at; undefined when it isn't there. */
export function observe(a: Assertion, s: Subject): string | undefined {
  switch (a.target) {
    case "status":
      return s.status === undefined ? undefined : String(s.status);
    case "body":
      return s.body;
    case "output":
      return s.output;
    case "duration":
      return s.durationMs === undefined ? undefined : String(s.durationMs);
    case "exitCode":
      return s.exitCode === undefined ? undefined : String(s.exitCode);
    case "header":
      return s.headers?.[(a.path ?? "").toLowerCase()];
    case "var":
      return s.vars[a.path ?? ""];
    case "json": {
      if (s.body === undefined) return undefined;
      let data: unknown;
      try {
        data = JSON.parse(s.body);
      } catch {
        return undefined;
      }
      const found = a.path ? jsonPath(data, a.path) : data;
      return found === undefined ? undefined : stringify(found);
    }
  }
}

const describe = (a: Assertion): string => `${a.target}${a.path ? ` ${a.path}` : ""} ${a.op}${a.value !== undefined && a.value !== "" ? ` ${a.value}` : ""}`;
const show = (v: string | undefined): string => (v === undefined ? "nothing" : v.length > 120 ? `${JSON.stringify(v.slice(0, 120))}…` : JSON.stringify(v));

export function evaluate(a: Assertion, s: Subject): AssertionResult {
  const found = observe(a, s);
  const want = a.value ?? "";
  let passed: boolean;
  let regexError: string | undefined;
  switch (a.op) {
    case "exists":
      passed = found !== undefined && found !== "";
      break;
    case "notExists":
      passed = found === undefined || found === "";
      break;
    case "equals":
      passed = found !== undefined && found === want;
      break;
    case "notEquals":
      passed = found !== want;
      break;
    case "contains":
      passed = found !== undefined && found.includes(want);
      break;
    case "notContains":
      passed = found === undefined || !found.includes(want);
      break;
    case "matches":
      try {
        passed = found !== undefined && new RegExp(want).test(found);
      } catch (err) {
        passed = false;
        regexError = err instanceof Error ? err.message : String(err);
      }
      break;
    case "gt":
    case "lt": {
      const n = Number(found);
      const m = Number(want);
      passed = found !== undefined && Number.isFinite(n) && Number.isFinite(m) && (a.op === "gt" ? n > m : n < m);
      break;
    }
  }
  const message = regexError ? `invalid pattern: ${regexError}` : passed ? `${describe(a)} ✓` : `${describe(a)} — found ${show(found)}`;
  return { assertion: a, passed, message };
}

export function evaluateAll(assertions: Assertion[] | undefined, s: Subject): AssertionResult[] {
  return (assertions ?? []).map((a) => evaluate(a, s));
}

/** Whether an HTTP status matches `2xx`, `200,201`, `200-299` or `any`. */
export function statusMatches(status: number, expect: string | undefined): boolean {
  const spec = (expect ?? "2xx").trim().toLowerCase();
  if (spec === "any" || spec === "") return true;
  return spec.split(",").some((part) => {
    const p = part.trim();
    if (/^\dxx$/.test(p)) return Math.floor(status / 100) === Number(p[0]);
    const range = /^(\d+)-(\d+)$/.exec(p);
    if (range) return status >= Number(range[1]) && status <= Number(range[2]);
    return Number(p) === status;
  });
}
