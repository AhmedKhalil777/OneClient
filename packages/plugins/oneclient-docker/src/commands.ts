import type { CommandHandler } from "@oneclient/plugin-api";
import { describeDockerError } from "./errors.js";
import { requireSession } from "./sessions.js";

interface ConnectionArg {
  connectionId: string;
}
interface ContainerArg extends ConnectionArg {
  containerId: string;
}
interface PullArg extends ConnectionArg {
  image: string;
}

function arg<T>(args: unknown[]): T {
  const value = args[0] as T | undefined;
  if (!value) throw new Error("Missing command argument.");
  return value;
}

/**
 * Tier 1-compatible actions (available to the command palette, same as any
 * contributed command) that also happen to be what the Tier 2 dashboard's
 * buttons invoke via `ViewHostApi.invokeCommand`. The dashboard already
 * knows its own `connectionId` (it was passed the connection it's open
 * for), so it just includes it in the args — no magic context injection
 * needed on core's side.
 */
export function createCommandHandlers(): CommandHandler[] {
  return [
    {
      commandId: "docker.listContainers",
      async execute(args) {
        const { connectionId } = arg<ConnectionArg>(args);
        const containers = await requireSession(connectionId).listContainers({ all: true });
        return containers.map((c) => ({
          id: c.Id,
          name: (c.Names[0] ?? c.Id).replace(/^\//, ""),
          image: c.Image,
          state: c.State,
          status: c.Status,
          // The Engine API returns null (not []) for containers with no published ports.
          ports: (c.Ports ?? []).map((p) =>
            p.PublicPort ? `${p.PublicPort}->${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`,
          ),
        }));
      },
    },
    {
      commandId: "docker.listImages",
      async execute(args) {
        const { connectionId } = arg<ConnectionArg>(args);
        const images = await requireSession(connectionId).listImages();
        return images.map((img) => ({
          id: img.Id,
          tag: img.RepoTags?.[0] ?? "<none>:<none>",
          size: img.Size,
          created: img.Created,
        }));
      },
    },
    {
      commandId: "docker.startContainer",
      async execute(args) {
        const { connectionId, containerId } = arg<ContainerArg>(args);
        try {
          await requireSession(connectionId).getContainer(containerId).start();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: describeDockerError(err) };
        }
      },
    },
    {
      commandId: "docker.stopContainer",
      async execute(args) {
        const { connectionId, containerId } = arg<ContainerArg>(args);
        try {
          await requireSession(connectionId).getContainer(containerId).stop();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: describeDockerError(err) };
        }
      },
    },
    {
      commandId: "docker.restartContainer",
      async execute(args) {
        const { connectionId, containerId } = arg<ContainerArg>(args);
        try {
          await requireSession(connectionId).getContainer(containerId).restart();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: describeDockerError(err) };
        }
      },
    },
    {
      commandId: "docker.removeContainer",
      async execute(args) {
        const { connectionId, containerId } = arg<ContainerArg>(args);
        try {
          await requireSession(connectionId).getContainer(containerId).remove({ force: true });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: describeDockerError(err) };
        }
      },
    },
    {
      commandId: "docker.pullImage",
      async execute(args) {
        const { connectionId, image } = arg<PullArg>(args);
        const client = requireSession(connectionId);
        try {
          await new Promise<void>((resolve, reject) => {
            client.pull(image, (err: Error | null, stream?: NodeJS.ReadableStream) => {
              if (err || !stream) return reject(err ?? new Error("No pull stream returned."));
              client.modem.followProgress(stream, (err2: Error | null) => (err2 ? reject(err2) : resolve()));
            });
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: describeDockerError(err) };
        }
      },
    },
  ];
}
