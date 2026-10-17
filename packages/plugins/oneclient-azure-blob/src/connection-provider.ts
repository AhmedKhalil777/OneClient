import type { ConnectionProvider } from "@oneclient/plugin-api";
import { AUTH_ACCOUNT_KEY, AUTH_AZURITE, AUTH_CONNECTION_STRING, AUTH_SAS, type BlobConnectionConfig, buildService, describeBlobError } from "./client.js";
import { listContainers } from "./blobs.js";
import { closeSession, openSession } from "./sessions.js";

export function createConnectionProvider(): ConnectionProvider<BlobConnectionConfig> {
  return {
    typeId: "azure-blob",
    configSchema: {
      type: "object",
      properties: {
        authentication: { type: "string", title: "Sign in with", enum: [AUTH_CONNECTION_STRING, AUTH_ACCOUNT_KEY, AUTH_SAS, AUTH_AZURITE], default: AUTH_CONNECTION_STRING },
        connectionString: {
          type: "string",
          title: "Connection string",
          "x-secret": true,
          description: "Azure portal → storage account → Access keys. “UseDevelopmentStorage=true” works for Azurite.",
        },
        accountName: { type: "string", title: "Account name", description: "For “Account name and key”." },
        accountKey: { type: "string", title: "Account key", "x-secret": true, description: "For “Account name and key”." },
        sasUrl: { type: "string", title: "SAS URL", "x-secret": true, description: "An account or container SAS URL (…blob.core.windows.net/…?sv=…)." },
        endpoint: { type: "string", title: "Blob endpoint (optional)", description: "Only for sovereign clouds, custom domains or a non-default Azurite address." },
      },
    },

    async connect(config, ctx) {
      if (!ctx.connectionId) throw new Error("connect() requires a saved connection.");
      openSession(ctx.connectionId, config);
      return { id: ctx.connectionId, typeId: "azure-blob", state: {} };
    },

    async test(config) {
      const started = Date.now();
      try {
        const h = buildService(config);
        const containers = await listContainers(h);
        return {
          success: true,
          message: `Connected to ${h.accountName} — ${containers.length} container${containers.length === 1 ? "" : "s"}${h.credential ? "" : " (read with SAS: SAS links can't be signed)"}.`,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        return { success: false, message: describeBlobError(err) };
      }
    },

    async disconnect(_handle, ctx) {
      if (ctx.connectionId) closeSession(ctx.connectionId);
    },
  };
}
