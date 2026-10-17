import type { ConnectionProvider } from "@oneclient/plugin-api";
import { createDockerClient, type DockerConnectionConfig } from "./docker-client.js";
import { describeDockerError } from "./errors.js";
import { sessions } from "./sessions.js";

export function createConnectionProvider(): ConnectionProvider<DockerConnectionConfig> {
  return {
    typeId: "docker",
    configSchema: {
      type: "object",
      properties: {
        host: {
          type: "string",
          title: "Remote host (optional)",
          description: 'e.g. "tcp://192.168.1.10:2375". Leave blank to use the local Docker socket/named pipe.',
        },
      },
    },

    async connect(config, ctx) {
      const client = createDockerClient(config);
      await client.ping();
      if (ctx.connectionId) sessions.set(ctx.connectionId, client);
      return { id: ctx.connectionId ?? `docker-${Date.now()}`, typeId: "docker", state: {} };
    },

    async test(config) {
      try {
        const client = createDockerClient(config);
        await client.ping();
        const info = await client.info();
        return {
          success: true,
          message: `Connected to Docker ${info.ServerVersion ?? ""} — ${info.Containers ?? 0} container(s), ${info.Images ?? 0} image(s).`,
        };
      } catch (err) {
        return { success: false, message: describeDockerError(err) };
      }
    },

    async disconnect(_handle, ctx) {
      if (ctx.connectionId) sessions.delete(ctx.connectionId);
    },
  };
}
