import { type KeycloakClient, KeycloakError } from "./client.js";

const enc = encodeURIComponent;

export type Grant = "password" | "client_credentials" | "refresh_token";

export interface TokenRequest {
  realm: string;
  clientId: string;
  clientSecret?: string | undefined;
  grant: Grant;
  username?: string | undefined;
  password?: string | undefined;
  refreshToken?: string | undefined;
  scope?: string | undefined;
}

export interface RawResponse {
  status: number;
  /** Parsed JSON, or the text if it wasn't JSON. */
  body: unknown;
}

const tokenPath = (realm: string) => `/realms/${enc(realm)}/protocol/openid-connect/token`;

/**
 * Ask the realm's token endpoint for a token — what an application would do, as any client/user you choose. The
 * response is returned as-is even on failure: an `invalid_grant` or `invalid_scope` body is exactly what you
 * want to read when debugging a login problem.
 */
export async function requestToken(client: KeycloakClient, req: TokenRequest): Promise<RawResponse> {
  if (!req.clientId) throw new KeycloakError("Client ID is required.");
  const form: Record<string, string | undefined> = {
    grant_type: req.grant,
    client_id: req.clientId,
    client_secret: req.clientSecret || undefined,
    scope: req.scope || undefined,
  };
  if (req.grant === "password") {
    if (!req.username || !req.password) throw new KeycloakError("Username and password are required for this grant.");
    Object.assign(form, { username: req.username, password: req.password });
  } else if (req.grant === "refresh_token") {
    if (!req.refreshToken) throw new KeycloakError("A refresh token is required.");
    form.refresh_token = req.refreshToken;
  } else if (!req.clientSecret) {
    throw new KeycloakError("Client credentials need the client's secret.");
  }
  const res = await client.send("POST", tokenPath(req.realm), { form, anonymous: true });
  return { status: res.status, body: res.data };
}

/** RFC 7662 introspection: is this token active, and what does the server know about it? */
export async function introspectToken(client: KeycloakClient, p: { realm: string; clientId: string; clientSecret?: string | undefined; token: string }): Promise<RawResponse> {
  if (!p.clientId || !p.clientSecret) throw new KeycloakError("Introspection needs a confidential client: enter its ID and secret.");
  const res = await client.send("POST", `${tokenPath(p.realm)}/introspect`, {
    form: { token: p.token, client_id: p.clientId, client_secret: p.clientSecret },
    anonymous: true,
  });
  return { status: res.status, body: res.data };
}

export async function userInfo(client: KeycloakClient, p: { realm: string; token: string }): Promise<RawResponse> {
  const res = await client.send("GET", `/realms/${enc(p.realm)}/protocol/openid-connect/userinfo`, { headers: { Authorization: `Bearer ${p.token.trim()}` }, anonymous: true });
  return { status: res.status, body: res.data };
}

export type ExampleKind = "access" | "id" | "userinfo";

/**
 * "Evaluate": the claims a client would get for a user and a set of scopes, computed by the server from the
 * current configuration (mappers, scopes, roles) without anyone logging in.
 */
export async function exampleToken(client: KeycloakClient, p: { realm: string; clientUuid: string; userId: string; scope?: string | undefined; kind: ExampleKind }): Promise<unknown> {
  const suffix = { access: "generate-example-access-token", id: "generate-example-id-token", userinfo: "generate-example-userinfo" }[p.kind];
  return client.get(`/${enc(p.realm)}/clients/${enc(p.clientUuid)}/evaluate-scopes/${suffix}`, { userId: p.userId, scope: p.scope || undefined });
}
