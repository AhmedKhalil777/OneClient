import { describe, expect, it } from "vitest";
import { decodeJwt, humanizeSeconds, isExpired, rolesOf, timeClaims } from "../src/jwt.js";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (payload: Record<string, unknown>) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig`;

describe("jwt", () => {
  it("decodes header and payload, tolerating a Bearer prefix", () => {
    const r = decodeJwt(`Bearer ${token({ sub: "u1", preferred_username: "alice" })}`);
    expect(r.ok && r.jwt.header.alg).toBe("RS256");
    expect(r.ok && r.jwt.payload.preferred_username).toBe("alice");
  });

  it("rejects things that are not JWTs", () => {
    expect(decodeJwt("nope").ok).toBe(false);
    expect(decodeJwt("a.b.c").ok).toBe(false);
  });

  it("reads realm and client roles", () => {
    const roles = rolesOf({ realm_access: { roles: ["editor"] }, resource_access: { app: { roles: ["admin"] } } });
    expect(roles).toEqual({ realm: ["editor"], clients: { app: ["admin"] } });
  });

  it("reports expiry relative to now", () => {
    const now = 1_700_000_000_000;
    expect(isExpired({ exp: now / 1000 - 5 }, now)).toBe(true);
    expect(isExpired({ exp: now / 1000 + 60 }, now)).toBe(false);
    expect(timeClaims({ exp: now / 1000 + 90 }, now)[0]?.claim).toBe("exp");
    expect(humanizeSeconds(90)).toBe("in 2 minutes");
    expect(humanizeSeconds(-30)).toBe("30 seconds ago");
  });
});
