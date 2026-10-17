import type { ConnectionProvider } from "@oneclient/plugin-api";
import { AUTH_CLIENT, AUTH_PASSWORD, KeycloakClient, type KeycloakConnectionConfig, KeycloakError } from "./client.js";
import { dropClient, setClient } from "./sessions.js";

export function createConnectionProvider(): ConnectionProvider<KeycloakConnectionConfig> {
  return {
    typeId: "keycloak",
    configSchema: {
      type: "object",
      required: ["serverUrl"],
      properties: {
        serverUrl: {
          type: "string",
          title: "Server URL",
          examples: ["http://localhost:8080"],
          description: "The Keycloak root, e.g. http://localhost:8080. A pasted admin-console URL is fine; the /auth prefix of older versions is detected.",
        },
        authentication: { type: "string", title: "Sign in with", enum: [AUTH_PASSWORD, AUTH_CLIENT], default: AUTH_PASSWORD },
        authRealm: { type: "string", title: "Sign-in realm", examples: ["master"], description: "The realm the admin account / client lives in — usually master." },
        username: { type: "string", title: "Username", description: "Admin user only." },
        password: { type: "string", title: "Password", "x-secret": true, description: "Admin user only." },
        clientId: {
          type: "string",
          title: "Client ID",
          examples: ["admin-cli"],
          description: "Admin user: leave blank for admin-cli. Service account: the client's ID.",
        },
        clientSecret: { type: "string", title: "Client secret", "x-secret": true, description: "Service account only (and confidential admin clients)." },
        allowSelfSignedCertificate: {
          type: "boolean",
          title: "Accept self-signed certificate",
          default: false,
          description: "For dev servers using https with a self-signed certificate.",
        },
      },
    },

    async connect(config, ctx) {
      if (!ctx.connectionId) throw new Error("connect() requires a saved connection.");
      const client = new KeycloakClient(config);
      await client.connect();
      setClient(ctx.connectionId, client);
      return { id: ctx.connectionId, typeId: "keycloak", state: {} };
    },

    async test(config) {
      const started = Date.now();
      try {
        const client = new KeycloakClient(config);
        await client.connect();
        let version = "";
        try {
          version = ((await client.get<{ systemInfo?: { version?: string } }>("/admin/serverinfo")).systemInfo?.version ?? "").trim();
        } catch {
          /* serverinfo needs extra rights on some setups — sign-in itself already succeeded */
        }
        const realms = await client.get<unknown[]>("/admin/realms");
        return {
          success: true,
          message: `Connected to Keycloak${version ? ` ${version}` : ""} as ${client.loginDescription} — ${realms.length} realm${realms.length === 1 ? "" : "s"} visible.`,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        return { success: false, message: err instanceof KeycloakError ? err.message : err instanceof Error ? err.message : String(err) };
      }
    },

    async disconnect(_handle, ctx) {
      if (ctx.connectionId) dropClient(ctx.connectionId);
    },
  };
}
