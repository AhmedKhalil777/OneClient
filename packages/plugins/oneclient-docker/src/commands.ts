import type { CommandHandler, TreeNode } from "@oneclient/plugin-api";
import { describeDockerError } from "./errors.js";
import type { Infrastructure } from "./infra.js";
import type { TestContainers } from "./test-runner.js";
import type { TestContainerRequest } from "./testcontainers.js";
import { fetchTags, matchLocal, normalizeSearch } from "./registry.js";
import { matchTemplate } from "./templates.js";
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
interface RunTemplateArg extends ConnectionArg {
  template: string;
  name: string;
  ports: Record<string, number>;
  variables: Record<string, string>;
  connectionName: string;
}

/** The dashboard, opened on its Templates tab. */
function templatesTab(): TreeNode {
  return { id: "docker-templates", label: "Templates", nodeType: "docker.templates", collapsible: "none", openView: { viewId: "docker.dashboard", title: "Docker Templates", icon: "$(docker-image)", params: { tab: "templates" } } };
}

/** The dashboard, opened on its Test Containers tab. */
function testContainersTab(): TreeNode {
  return { id: "docker-test-containers", label: "Test Containers", nodeType: "docker.testcontainers", collapsible: "none", openView: { viewId: "docker.dashboard", title: "Docker Test Containers", icon: "$(docker-container)", params: { tab: "tests" } } };
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
export function createCommandHandlers(infra: Infrastructure, tests: TestContainers): CommandHandler[] {
  return [
    {
      commandId: "docker.listContainers",
      async execute(args) {
        const { connectionId } = arg<ConnectionArg>(args);
        const containers = await requireSession(connectionId).listContainers({ all: true });
        const owners = await infra.annotate(containers).catch(() => new Map());
        return containers.map((c) => ({
          plugin: owners.get(c.Id)
            ? {
                pluginId: owners.get(c.Id)!.template.pluginId,
                product: owners.get(c.Id)!.template.product ?? owners.get(c.Id)!.template.title,
                icon: owners.get(c.Id)!.template.icon ?? "",
                connections: owners.get(c.Id)!.connections.map((x: { id: string; name: string }) => ({ id: x.id, name: x.name })),
              }
            : null,
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
      commandId: "docker.listTemplates",
      async execute(args) {
        const { connectionId } = arg<ConnectionArg>(args);
        return infra.catalog(connectionId);
      },
    },
    {
      commandId: "docker.runTemplate",
      async execute(args) {
        const a = arg<RunTemplateArg>(args);
        try {
          return { ok: true, ...(await infra.run(a)) };
        } catch (err) {
          return { ok: false, error: describeDockerError(err) };
        }
      },
    },
    {
      commandId: "docker.connectContainer",
      async execute(args) {
        const { connectionId, containerId } = arg<ContainerArg>(args);
        try {
          return { ok: true, ...(await infra.connectExisting(connectionId, containerId)) };
        } catch (err) {
          return { ok: false, error: describeDockerError(err) };
        }
      },
    },
    {
      // Image search like a package manager: what is already local, and what the registry (Docker Hub) offers.
      commandId: "docker.searchImages",
      async execute(args) {
        const { connectionId, term } = arg<ConnectionArg & { term: string }>(args);
        const client = requireSession(connectionId);
        // A plugin's icon for images it recognises (postgres → the PostgreSQL icon); the picker falls back to the Docker image icon.
        const templates = await infra.templates().catch(() => []);
        const iconOf = (image: string) => matchTemplate({ image }, templates)?.icon ?? "";
        const local = matchLocal((await client.listImages()).flatMap((i) => i.RepoTags ?? []), term).map((name) => ({ name, icon: iconOf(name) }));
        if (term.trim().length < 2) return { local, hub: [] };
        try {
          const hub = normalizeSearch(await client.searchImages({ term: term.trim(), limit: 25 })).map((h) => ({ ...h, icon: iconOf(h.name) }));
          return { local, hub };
        } catch (err) {
          return { local, hub: [], error: describeDockerError(err) };
        }
      },
    },
    {
      commandId: "docker.imageTags",
      async execute(args) {
        const { image } = arg<ConnectionArg & { image: string }>(args);
        try {
          return await fetchTags(image, async (url) => {
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) throw new Error(res.status === 404 ? "No such repository on Docker Hub." : `Docker Hub answered ${res.status}.`);
            return res.json();
          });
        } catch (err) {
          return { tags: [], error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      commandId: "docker.listTestContainers",
      async execute(args) {
        const { connectionId } = arg<ConnectionArg>(args);
        return tests.list(connectionId);
      },
    },
    {
      commandId: "docker.runTestContainer",
      async execute(args) {
        const { connectionId, request } = arg<ConnectionArg & { request: TestContainerRequest }>(args);
        try {
          return { ok: true, ...(await tests.run(connectionId, request)) };
        } catch (err) {
          return { ok: false, error: describeDockerError(err) };
        }
      },
    },
    {
      commandId: "docker.cleanupTestContainers",
      async execute(args) {
        const { connectionId } = arg<ConnectionArg>(args);
        try {
          const removed = await tests.cleanup(connectionId);
          return { ok: true, message: removed ? `Removed ${removed} test container${removed === 1 ? "" : "s"}.` : "No test containers to remove." };
        } catch (err) {
          return { ok: false, error: describeDockerError(err) };
        }
      },
    },
    {
      commandId: "docker.openTestContainers",
      async execute() {
        return { ok: true, openNode: testContainersTab() };
      },
    },
    {
      commandId: "docker.openTemplates",
      async execute() {
        return { ok: true, openNode: templatesTab() };
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
