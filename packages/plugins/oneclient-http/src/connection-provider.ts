import type { ConnectionProvider } from "@oneclient/plugin-api";
import { type HttpConnectionConfig, dropSession, setSession } from "./sessions.js";
import { dropWorkspace, workspaceFor } from "./store.js";

/**
 * An "HTTP workspace": a named place for collections, environments and history. The connection itself holds only
 * the request defaults below; everything else is in the workspace file next to oneclient.json (see store.ts).
 */
export function createConnectionProvider(): ConnectionProvider<HttpConnectionConfig> {
  return {
    typeId: "http",
    configSchema: {
      type: "object",
      properties: {
        timeoutSeconds: { type: "number", title: "Request timeout (seconds)", default: 30, minimum: 1 },
        followRedirects: { type: "boolean", title: "Follow redirects", default: true },
        allowSelfSignedCertificate: {
          type: "boolean",
          title: "Accept self-signed certificates",
          default: false,
          description: "For dev servers using https with a self-signed certificate.",
        },
      },
    },

    async connect(config, ctx) {
      if (!ctx.connectionId) throw new Error("connect() requires a saved connection.");
      setSession(ctx.connectionId, config);
      workspaceFor(ctx.connectionId); // loads (and migrates) the workspace file; throws a clear error if it's from a newer version
      return { id: ctx.connectionId, typeId: "http", state: {} };
    },

    async test() {
      return { success: true, message: "Ready — an HTTP workspace needs no server. Add collections or import from Postman after saving." };
    },

    async disconnect(_handle, ctx) {
      if (ctx.connectionId) {
        dropSession(ctx.connectionId);
        dropWorkspace(ctx.connectionId);
      }
    },
  };
}
