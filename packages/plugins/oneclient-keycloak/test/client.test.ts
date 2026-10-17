import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_CLIENT, AUTH_PASSWORD, KeycloakClient, KeycloakError, idFromLocation, normalizeBaseUrl } from "../src/client.js";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

/** A tiny fake Keycloak: configurable prefix ("" or "/auth"), tokens that can be made to expire. */
async function fakeKeycloak(opts: { prefix?: string; tokenTtl?: number; rejectFirstAdminCall?: boolean } = {}) {
  const prefix = opts.prefix ?? "";
  const seen: Seen[] = [];
  let tokenCounter = 0;
  let adminCalls = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      const url = req.url ?? "";
      if (!url.startsWith(prefix)) return send(404, { error: "Not Found" });
      const path = url.slice(prefix.length);

      if (req.method === "POST" && path === "/realms/master/protocol/openid-connect/token") {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "password" && form.get("password") !== "right") return send(401, { error: "invalid_grant", error_description: "Invalid user credentials" });
        if (form.get("grant_type") === "client_credentials" && form.get("client_secret") !== "s3cret") return send(401, { error: "unauthorized_client", error_description: "Invalid client secret" });
        tokenCounter++;
        return send(200, { access_token: `token-${tokenCounter}`, expires_in: opts.tokenTtl ?? 300 });
      }
      if (path.startsWith("/realms/nope/")) return send(404, { error: "Realm does not exist" });
      if (path.startsWith("/admin/realms")) {
        adminCalls++;
        if (opts.rejectFirstAdminCall && adminCalls === 1) return send(401, { error: "HTTP 401 Unauthorized" });
        if (req.headers.authorization === undefined) return send(401, { error: "HTTP 401 Unauthorized" });
        if (path.startsWith("/admin/realms/master/forbidden")) return send(403, { error: "HTTP 403 Forbidden" });
        if (path.startsWith("/admin/realms/master/users") && req.method === "POST") return send(201, undefined, { location: `http://x/admin/realms/master/users/abc-123` });
        if (path.startsWith("/admin/realms/master/users")) return send(200, [{ id: "1", username: "alice" }]);
        if (path.startsWith("/admin/realms/master/conflict")) return send(409, { errorMessage: "User exists with same username" });
        return send(200, { ok: true });
      }
      return send(404, { error: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});
async function start(opts?: Parameters<typeof fakeKeycloak>[0]) {
  const kc = await fakeKeycloak(opts);
  closers.push(kc.close);
  return kc;
}

const password = (url: string, extra = {}) => ({ serverUrl: url, authentication: AUTH_PASSWORD, username: "admin", password: "right", ...extra });

describe("normalizeBaseUrl", () => {
  it("adds http://, trims slashes and cuts off pasted console/admin paths", () => {
    expect(normalizeBaseUrl("localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeBaseUrl("https://kc.example.com/")).toBe("https://kc.example.com");
    expect(normalizeBaseUrl("https://kc.example.com/auth/admin/master/console/#/master")).toBe("https://kc.example.com/auth");
    expect(normalizeBaseUrl("http://kc/realms/master/account")).toBe("http://kc");
  });
  it("rejects an empty URL", () => {
    expect(() => normalizeBaseUrl("  ")).toThrow(KeycloakError);
  });
});

describe("KeycloakClient sign-in", () => {
  it("signs in with the password grant on admin-cli and sends the bearer token on admin calls", async () => {
    const kc = await start();
    const client = new KeycloakClient(password(kc.url));
    await client.connect();
    expect(new URLSearchParams(kc.seen[0]!.body).toString()).toBe("grant_type=password&client_id=admin-cli&username=admin&password=right");
    expect(await client.get("/master/users")).toEqual([{ id: "1", username: "alice" }]);
    expect(kc.seen[1]).toMatchObject({ method: "GET", url: "/admin/realms/master/users", auth: "Bearer token-1" });
  });

  it("signs in with client credentials", async () => {
    const kc = await start();
    const client = new KeycloakClient({ serverUrl: kc.url, authentication: AUTH_CLIENT, clientId: "svc", clientSecret: "s3cret" });
    await client.connect();
    expect(new URLSearchParams(kc.seen[0]!.body).get("grant_type")).toBe("client_credentials");
    await expect(new KeycloakClient({ serverUrl: kc.url, authentication: AUTH_CLIENT, clientId: "svc", clientSecret: "bad" }).connect()).rejects.toThrow(/Invalid client secret/);
  });

  it("explains bad credentials and unknown realms", async () => {
    const kc = await start();
    await expect(new KeycloakClient(password(kc.url, { password: "wrong" })).connect()).rejects.toThrow("Sign-in failed: Invalid user credentials.");
    await expect(new KeycloakClient(password(kc.url, { authRealm: "nope" })).connect()).rejects.toThrow(/Realm "nope" was not found/);
  });

  it("finds legacy Keycloak under /auth by itself", async () => {
    const kc = await start({ prefix: "/auth" });
    const client = new KeycloakClient(password(kc.url));
    await client.connect();
    expect(client.baseUrl).toBe(`${kc.url}/auth`);
    expect(await client.get("/master/users")).toBeTruthy();
    expect(kc.seen.at(-1)!.url).toBe("/auth/admin/realms/master/users");
  });

  it("explains an unreachable server", async () => {
    await expect(new KeycloakClient(password("http://127.0.0.1:1")).connect()).rejects.toThrow(/Can't connect to http:\/\/127\.0\.0\.1:1/);
  });

  it("requires credentials before even trying", async () => {
    await expect(new KeycloakClient({ serverUrl: "http://x", authentication: AUTH_PASSWORD }).connect()).rejects.toThrow("Username and password are required.");
    await expect(new KeycloakClient({ serverUrl: "http://x", authentication: AUTH_CLIENT }).connect()).rejects.toThrow("Client ID is required");
  });
});

describe("KeycloakClient admin calls", () => {
  it("reuses a valid token and signs in again once it has expired", async () => {
    const kc = await start({ tokenTtl: 60 });
    const client = new KeycloakClient(password(kc.url));
    const tokenRequests = () => kc.seen.filter((s) => s.url.includes("openid-connect/token")).length;
    await client.get("/master/users"); // signs in lazily
    await client.get("/master/users");
    expect(tokenRequests()).toBe(1);

    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 55_000); // within the 10s early-renewal margin of the 60s lifetime
    try {
      await client.get("/master/users");
    } finally {
      spy.mockRestore();
    }
    expect(tokenRequests()).toBe(2);
    expect(kc.seen.filter((s) => s.url.startsWith("/admin/")).map((s) => s.auth)).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-2"]);
  });

  it("retries once with a fresh token after a 401", async () => {
    const kc = await start({ rejectFirstAdminCall: true });
    const client = new KeycloakClient(password(kc.url));
    await client.connect();
    expect(await client.get("/master/users")).toBeTruthy();
    const admin = kc.seen.filter((s) => s.url.startsWith("/admin/"));
    expect(admin.map((a) => a.auth)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("turns error statuses into readable errors", async () => {
    const kc = await start();
    const client = new KeycloakClient(password(kc.url));
    await expect(client.get("/master/forbidden")).rejects.toThrow(/Forbidden — the signed-in account isn't allowed/);
    await expect(client.get("/master/conflict")).rejects.toMatchObject({ status: 409, message: "Conflict: User exists with same username." });
  });

  it("encodes query parameters, skipping empty ones, and returns the id of created things", async () => {
    const kc = await start();
    const client = new KeycloakClient(password(kc.url));
    await client.get("/master/users", { search: "a b&c", first: 0, max: 10, empty: "", missing: undefined });
    expect(kc.seen.at(-1)!.url).toBe("/admin/realms/master/users?search=a%20b%26c&first=0&max=10");
    const created = await client.post("/master/users", { username: "bob" });
    expect(idFromLocation(created)).toBe("abc-123");
  });

  it("accepts absolute /admin/ paths", async () => {
    const kc = await start();
    const client = new KeycloakClient(password(kc.url));
    await client.get("/admin/realms/master/users");
    expect(kc.seen.at(-1)!.url).toBe("/admin/realms/master/users");
  });
});
