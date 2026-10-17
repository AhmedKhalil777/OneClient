/**
 * JWT decoding, shared by the plugin backend and its UI (so it only uses APIs both have: atob, TextDecoder).
 * It decodes — it does NOT verify signatures; verifying needs the realm's public keys (see the JWKS tool).
 */

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** Base64url signature, as in the token. */
  signature: string;
}

export type JwtResult = { ok: true; jwt: DecodedJwt } | { ok: false; error: string };

function base64UrlToBytes(part: string): Uint8Array {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodePart(part: string, what: string): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(part));
  } catch {
    throw new Error(`The ${what} isn't valid base64url text.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`The ${what} isn't valid JSON.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`The ${what} isn't a JSON object.`);
  return value as Record<string, unknown>;
}

export function decodeJwt(token: string): JwtResult {
  const cleaned = token.trim().replace(/^Bearer\s+/i, "");
  const parts = cleaned.split(".");
  if (parts.length < 2 || parts.length > 3 || parts.some((p, i) => i < 2 && p === "")) {
    return { ok: false, error: "That doesn't look like a JWT (expected header.payload.signature)." };
  }
  try {
    return { ok: true, jwt: { header: decodePart(parts[0]!, "header"), payload: decodePart(parts[1]!, "payload"), signature: parts[2] ?? "" } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface TimeClaim {
  claim: "exp" | "iat" | "nbf" | "auth_time";
  /** ISO-8601, UTC. */
  iso: string;
  /** "in 4 minutes" / "2 hours ago". */
  relative: string;
}

const TIME_CLAIMS = ["exp", "iat", "nbf", "auth_time"] as const;

export function humanizeSeconds(deltaSeconds: number): string {
  const abs = Math.abs(deltaSeconds);
  const unit = abs < 90 ? [Math.round(abs), "second"] : abs < 5400 ? [Math.round(abs / 60), "minute"] : abs < 129600 ? [Math.round(abs / 3600), "hour"] : [Math.round(abs / 86400), "day"];
  const text = `${unit[0]} ${unit[1]}${unit[0] === 1 ? "" : "s"}`;
  return deltaSeconds >= 0 ? `in ${text}` : `${text} ago`;
}

/** The timestamp claims of a payload, readable ("exp: 2026-10-17T15:21:33Z (in 4 minutes)"), relative to `nowMs`. */
export function timeClaims(payload: Record<string, unknown>, nowMs: number = Date.now()): TimeClaim[] {
  const out: TimeClaim[] = [];
  for (const claim of TIME_CLAIMS) {
    const v = payload[claim];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out.push({ claim, iso: new Date(v * 1000).toISOString().replace(".000Z", "Z"), relative: humanizeSeconds(Math.round(v - nowMs / 1000)) });
  }
  return out;
}

/** true/false for exp, or undefined if the token has none. */
export function isExpired(payload: Record<string, unknown>, nowMs: number = Date.now()): boolean | undefined {
  return typeof payload.exp === "number" ? payload.exp * 1000 <= nowMs : undefined;
}

/** All roles a Keycloak access token grants: realm roles and per-client roles. */
export function rolesOf(payload: Record<string, unknown>): { realm: string[]; clients: Record<string, string[]> } {
  const realmAccess = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
  const resourceAccess = (payload.resource_access ?? {}) as Record<string, { roles?: unknown }>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    realm: strings(realmAccess),
    clients: Object.fromEntries(Object.entries(resourceAccess).map(([client, v]) => [client, strings(v?.roles)])),
  };
}
