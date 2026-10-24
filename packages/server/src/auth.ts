import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";

const COOKIE = "oneclient_token";

/** The access token: `--token` / ONECLIENT_TOKEN, else one kept in `<home>/server-token` so links survive restarts. */
export function loadToken(file: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return saved;
  }
  mkdirSync(dirname(file), { recursive: true });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Who may use the server: whoever holds the token. The link the server prints carries it once (`?token=`); the server
 * swaps it for an HttpOnly, SameSite=Strict cookie and drops it from the URL. Every request and the WebSocket need the
 * cookie; the WebSocket must also come from this origin (no cross-site socket hijacking).
 */
export class Auth {
  constructor(
    private readonly token: string,
    /** Bound to loopback only: also refuse other Host names (DNS rebinding). */
    private readonly allowedHosts: Set<string> | null,
  ) {}

  hostAllowed(req: IncomingMessage): boolean {
    return !this.allowedHosts || this.allowedHosts.has(String(req.headers.host ?? "").toLowerCase());
  }

  hasCookie(req: IncomingMessage): boolean {
    const value = cookie(req, COOKIE);
    return value !== undefined && equal(value, this.token);
  }

  tokenMatches(candidate: string | null): boolean {
    return candidate !== null && equal(candidate, this.token);
  }

  setCookie(secure: boolean): string {
    return `${COOKIE}=${encodeURIComponent(this.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}${secure ? "; Secure" : ""}`;
  }

  /** The WebSocket's Origin is this server (same scheme-less host). */
  sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      return new URL(origin).host.toLowerCase() === String(req.headers.host ?? "").toLowerCase();
    } catch {
      return false;
    }
  }
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
