import { httpRequest } from "./http.js";
import { addLog, currentOp, redact } from "./log.js";

export const AUTH_PASSWORD = "Admin user (username & password)";
export const AUTH_CLIENT = "Service account (client credentials)";

export interface KeycloakConnectionConfig {
  serverUrl?: string;
  authentication?: string;
  /** Realm the admin account lives in (usually "master"). */
  authRealm?: string;
  username?: string;
  password?: string;
  /** OAuth client used to sign in: "admin-cli" for the password flow, or the service-account client. */
  clientId?: string;
  clientSecret?: string;
  allowSelfSignedCertificate?: boolean;
}

/** An error from Keycloak (or on the way to it) with a message fit to show to the user. */
export class KeycloakError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "KeycloakError";
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body. */
  body?: unknown;
  /** Form-encoded body (token endpoints). */
  form?: Record<string, string | undefined>;
  /** Send without the admin bearer token (public endpoints). */
  anonymous?: boolean;
  /** Extra headers (e.g. a different Authorization). */
  headers?: Record<string, string>;
}

export interface ApiResponse<T = unknown> {
  status: number;
  /** Parsed JSON, the raw text for non-JSON bodies, or null when empty. */
  data: T;
  headers: Record<string, string | string[] | undefined>;
}

/** "keycloak.example.com:8443/auth/admin/master/console" → "https://keycloak.example.com:8443/auth". */
export function normalizeBaseUrl(input: string | undefined): string {
  let url = (input ?? "").trim();
  if (!url) throw new KeycloakError("Server URL is required (e.g. http://localhost:8080).");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  // People paste the admin console URL; the API root is what comes before /admin or /realms.
  url = url.replace(/[?#].*$/, "").replace(/\/(admin|realms)(\/.*)?$/i, "").replace(/\/+$/, "");
  return url;
}

const enc = encodeURIComponent;

export class KeycloakClient {
  private base: string;
  private accessToken = "";
  private expiresAt = 0;
  private signingIn: Promise<void> | null = null;
  /** Legacy (WildFly) Keycloak serves everything under /auth; we find out on first contact. */
  private triedAuthPrefix = false;

  constructor(private readonly config: KeycloakConnectionConfig) {
    this.base = normalizeBaseUrl(config.serverUrl);
  }

  get baseUrl(): string {
    return this.base;
  }

  get authRealm(): string {
    return this.config.authRealm?.trim() || "master";
  }

  get loginDescription(): string {
    return this.config.authentication === AUTH_CLIENT ? `client ${this.config.clientId ?? ""}` : (this.config.username ?? "");
  }

  /** Sign in now so bad URLs and credentials fail at connect time, not on the first click. */
  async connect(): Promise<void> {
    await this.signIn();
  }

  /** A valid admin access token, signing in again when it's about to expire. */
  async token(): Promise<string> {
    if (Date.now() >= this.expiresAt) await this.signIn();
    return this.accessToken;
  }

  private signIn(): Promise<void> {
    this.signingIn ??= this.doSignIn().finally(() => {
      this.signingIn = null;
    });
    return this.signingIn;
  }

  private async doSignIn(): Promise<void> {
    const clientCredentials = this.config.authentication === AUTH_CLIENT;
    const form: Record<string, string | undefined> = clientCredentials
      ? { grant_type: "client_credentials", client_id: this.config.clientId, client_secret: this.config.clientSecret }
      : {
          grant_type: "password",
          client_id: this.config.clientId?.trim() || "admin-cli",
          username: this.config.username,
          password: this.config.password,
          client_secret: this.config.clientSecret || undefined,
        };
    if (clientCredentials && !this.config.clientId) throw new KeycloakError("Client ID is required for service-account sign-in.");
    if (!clientCredentials && (!this.config.username || !this.config.password)) throw new KeycloakError("Username and password are required.");

    const path = `/realms/${enc(this.authRealm)}/protocol/openid-connect/token`;
    let res = await this.send("POST", path, { form, anonymous: true });
    if (res.status === 404 && !this.triedAuthPrefix && !this.base.endsWith("/auth")) {
      // Keycloak before 17 lives under /auth. Remember the answer either way so we don't probe on every sign-in.
      this.triedAuthPrefix = true;
      const original = this.base;
      this.base = `${original}/auth`;
      res = await this.send("POST", path, { form, anonymous: true });
      if (res.status === 404) this.base = original;
    }
    if (res.status !== 200 || typeof res.data !== "object" || !res.data) {
      throw new KeycloakError(describeTokenFailure(res, this.authRealm), res.status);
    }
    const t = res.data as { access_token?: string; expires_in?: number };
    if (!t.access_token) throw new KeycloakError("Keycloak did not return an access token.");
    this.accessToken = t.access_token;
    // Renew a little early so a request never goes out with a token that expires in flight.
    this.expiresAt = Date.now() + Math.max(5, (t.expires_in ?? 60) - 10) * 1000;
  }

  /** Raw request relative to the server root (no `/admin/realms` prefix added). */
  async send<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const query = Object.entries(opts.query ?? {})
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${enc(k)}=${enc(String(v))}`)
      .join("&");
    const headers: Record<string, string> = { ...opts.headers };
    let body: string | undefined;
    if (opts.form) {
      body = Object.entries(opts.form)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${enc(k)}=${enc(v!)}`)
        .join("&");
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (opts.body !== undefined) {
      body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }
    const started = Date.now();
    const target = `${path}${query ? `?${query}` : ""}`;
    const record = (extra: { status?: number; error?: string; response?: string | undefined }) =>
      addLog({ time: started, op: currentOp() || (path.includes("/protocol/openid-connect/token") ? "sign in" : ""), server: this.base, method, path: target, ms: Date.now() - started, ...extra, ...(body !== undefined ? { request: redact(body) } : {}) });
    try {
      const res = await httpRequest({
        method,
        url: `${this.base}${target}`,
        headers,
        ...(body !== undefined ? { body } : {}),
        allowSelfSigned: this.config.allowSelfSignedCertificate === true,
      });
      record({ status: res.status, ...(res.status >= 400 ? { error: `HTTP ${res.status}` } : {}), ...(res.body && !/token|secret|credentials/i.test(target) ? { response: redact(res.body) } : {}) });
      return { status: res.status, headers: res.headers, data: parseBody(res.body, res.headers["content-type"]) as T };
    } catch (err) {
      const message = describeNetworkError(err, this.base);
      record({ error: message });
      throw new KeycloakError(message);
    }
  }

  /**
   * Admin API call: `path` is relative to `/admin/realms` ("/master/users"), `/admin/...` paths are used as given.
   * Adds the bearer token, signs in again once on 401, and turns error responses into KeycloakErrors.
   */
  async admin<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const full = path.startsWith("/admin/") ? path : `/admin/realms${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.send<T>(method, full, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${await this.token()}` } });
      if (res.status === 401 && attempt === 0) {
        this.expiresAt = 0; // token rejected (revoked / clock skew): sign in again and retry once
        continue;
      }
      if (res.status >= 400) throw new KeycloakError(describeApiFailure(res, method, full), res.status);
      return res;
    }
  }

  get = <T = unknown>(path: string, query?: RequestOptions["query"]) => this.admin<T>("GET", path, query ? { query } : {}).then((r) => r.data);
  post = (path: string, body?: unknown, query?: RequestOptions["query"]) =>
    this.admin("POST", path, { ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}) });
  put = (path: string, body?: unknown) => this.admin("PUT", path, body !== undefined ? { body } : {});
  del = (path: string, body?: unknown) => this.admin("DELETE", path, body !== undefined ? { body } : {});
}

/** The id at the end of a `Location: …/users/<id>` header (what POSTs that create things return). */
export function idFromLocation(res: ApiResponse): string | undefined {
  const loc = res.headers["location"];
  const value = Array.isArray(loc) ? loc[0] : loc;
  return value?.split("/").filter(Boolean).pop();
}

function parseBody(text: string, contentType: string | string[] | undefined): unknown {
  if (text === "") return null;
  const type = String(contentType ?? "");
  if (type.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      /* not JSON after all */
    }
  }
  return text;
}

function describeTokenFailure(res: ApiResponse, authRealm: string): string {
  const body = (res.data ?? {}) as { error?: string; error_description?: string };
  if (res.status === 404) return `Realm "${authRealm}" was not found at this URL — check the server URL (older Keycloak needs /auth) and the sign-in realm.`;
  if (body.error === "invalid_grant") return `Sign-in failed: ${body.error_description ?? "invalid username or password"}.`;
  if (body.error === "unauthorized_client" || body.error === "invalid_client") return `Sign-in failed: ${body.error_description ?? "the client ID/secret was rejected"}.`;
  const detail = body.error_description ?? body.error ?? (typeof res.data === "string" ? res.data.slice(0, 200) : "");
  return `Sign-in failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}.`;
}

function describeApiFailure(res: ApiResponse, method: string, path: string): string {
  const body = (res.data ?? {}) as { errorMessage?: string; error?: string; error_description?: string };
  const detail = body.errorMessage ?? body.error_description ?? body.error ?? (typeof res.data === "string" ? res.data.slice(0, 300) : "");
  if (res.status === 403) return `Forbidden — the signed-in account isn't allowed to do that${detail && detail !== "HTTP 403 Forbidden" ? ` (${detail})` : ""}. It needs realm-management roles.`;
  if (res.status === 404) return `Not found${detail && detail !== "HTTP 404 Not Found" ? `: ${detail}` : ""} (${method} ${path}).`;
  if (res.status === 409) return `Conflict: ${detail || "that already exists"}.`;
  return `${detail || `HTTP ${res.status}`}${res.status >= 500 ? ` (server error ${res.status})` : ""}`;
}

function describeNetworkError(err: unknown, base: string): string {
  const e = err as NodeJS.ErrnoException;
  const message = e.message ?? String(err);
  if (e.code === "ECONNREFUSED") return `Can't connect to ${base} — is Keycloak running and is the port right?`;
  if (e.code === "ENOTFOUND") return `Can't find the host in ${base}.`;
  if (e.code === "ETIMEDOUT" || /timed out/i.test(message)) return `${base} didn't answer in time.`;
  if (/self[- ]signed|certificate|CERT_/i.test(message) || /^(DEPTH_ZERO|UNABLE_TO_VERIFY|ERR_TLS)/.test(String(e.code))) {
    return `${message} — for a dev server with a self-signed certificate, tick "Accept self-signed certificate".`;
  }
  if (e.code === "ECONNRESET") return `The connection to ${base} was reset — check http vs https and the port.`;
  return message;
}
