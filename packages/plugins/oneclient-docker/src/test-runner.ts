import { connect } from "node:net";
import type Docker from "dockerode";
import type { PluginContext } from "@oneclient/plugin-api";
import { hasImage, pull, tailLogs } from "./infra.js";
import { hostAddress, requireSession, sessions } from "./sessions.js";
import { type Probes, type TestContainerRequest, TEST_LABEL, createTestOptions, isExpired, parsePorts, validateRequest, waitFor } from "./testcontainers.js";

export interface TestContainerResult {
  containerId: string;
  name: string;
  /** Where each published container port is reachable from this machine, e.g. "8080/tcp" → "127.0.0.1:49153". */
  endpoints: Record<string, string>;
  message: string;
}

/** Runs and cleans up ad-hoc test containers (see testcontainers.ts). */
export class TestContainers {
  private reaper: NodeJS.Timeout | undefined;

  private readonly out;

  constructor(private readonly context: PluginContext) {
    this.out = context.createOutputChannel("Test Containers");
  }

  /** Removes containers whose TTL has passed, on every live connection, now and then. */
  startReaper(): void {
    this.reaper ??= setInterval(() => void this.reapAll(), 30_000);
    this.reaper.unref?.();
  }

  stopReaper(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
  }

  private async reapAll(): Promise<void> {
    for (const client of sessions.values()) await this.reap(client).catch(() => undefined);
  }

  private async reap(client: Docker): Promise<void> {
    const containers = await client.listContainers({ all: true, filters: { label: [TEST_LABEL] } });
    for (const c of containers) {
      if (!isExpired(c.Labels)) continue;
      await client.getContainer(c.Id).remove({ force: true }).then(
        () => this.out.info(`Removed expired test container ${(c.Names[0] ?? c.Id).replace(/^\//, "")}.`),
        (err: unknown) => this.out.warn(`Could not remove expired test container ${c.Id.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  async run(connectionId: string, request: TestContainerRequest): Promise<TestContainerResult> {
    this.out.info(`Starting ${request.image.trim() || "(no image)"}${request.name.trim() ? ` as ${request.name.trim()}` : ""}…`);
    try {
      const result = await this.start(connectionId, request);
      this.out.info(result.message);
      return result;
    } catch (err) {
      this.out.error(`Test container ${request.image.trim()} failed: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err.stack : undefined);
      throw err;
    }
  }

  private async start(connectionId: string, request: TestContainerRequest): Promise<TestContainerResult> {
    const client = requireSession(connectionId);
    validateRequest(request);
    const options = createTestOptions(request);
    const image = request.image.trim();
    const host = hostAddress(connectionId);

    return this.context.tasks.run({ title: `Start test container (${request.name.trim() || image})`, cancellable: true }, async (task) => {
      if (!(await hasImage(client, image))) await pull(client, image, task);
      if (task.isCancelled) throw new Error("Stopped.");

      task.report({ detail: "Creating the container…" });
      const container = await client.createContainer(options);
      await container.start();
      task.log(`Started ${image} (${container.id.slice(0, 12)})\n`);

      const endpoints = await endpointsOf(container, host);
      for (const [port, where] of Object.entries(endpoints)) task.log(`${where} → ${port}\n`);

      const probes: Probes = {
        async state() {
          const s = (await container.inspect()).State;
          return { running: !!s.Running, exitCode: s.ExitCode, health: s.Health?.Status };
        },
        logs: () => tailLogs(container, 500),
        async portsOpen() {
          const where = Object.values(await endpointsOf(container, host));
          if (where.length < parsePorts(request.ports).length) return false;
          const results = await Promise.all(where.map((w) => canConnect(w)));
          return results.every(Boolean);
        },
      };
      try {
        await waitFor(request.wait, probes, Math.max(1, request.timeoutSeconds) * 1000, {
          onTick: (ms) => {
            if (task.isCancelled) throw new Error("Stopped.");
            task.report({ detail: `Waiting for the container to be ready… ${Math.round(ms / 1000)}s` });
          },
        });
      } catch (err) {
        const logs = await tailLogs(container, 20);
        throw new Error(`${err instanceof Error ? err.message : String(err)}${logs ? `\n\nLast log lines:\n${logs}` : ""}`);
      }

      const name = (await container.inspect()).Name.replace(/^\//, "");
      const message = `"${name}" is ready${Object.keys(endpoints).length ? ` — ${Object.entries(endpoints).map(([p, w]) => `${w} → ${p}`).join(", ")}` : ""}.`;
      task.log(`${message}\n`);
      return { containerId: container.id, name, endpoints, message };
    });
  }

  /** Removes every container carrying the test label. Returns how many. */
  async cleanup(connectionId: string): Promise<number> {
    const client = requireSession(connectionId);
    const containers = await client.listContainers({ all: true, filters: { label: [TEST_LABEL] } });
    let removed = 0;
    for (const c of containers) {
      await client.getContainer(c.Id).remove({ force: true, v: true });
      removed++;
    }
    return removed;
  }

  async list(connectionId: string) {
    const client = requireSession(connectionId);
    await this.reap(client).catch(() => undefined);
    const containers = await client.listContainers({ all: true, filters: { label: [TEST_LABEL] } });
    const host = hostAddress(connectionId);
    return containers.map((c) => ({
      id: c.Id,
      name: (c.Names[0] ?? c.Id).replace(/^\//, ""),
      image: c.Image,
      state: c.State,
      status: c.Status,
      endpoints: Object.fromEntries((c.Ports ?? []).filter((p) => p.PublicPort).map((p) => [`${p.PrivatePort}/${p.Type}`, `${host}:${p.PublicPort}`])),
    }));
  }
}

/** Published ports as Docker actually bound them (random ports are only known after start). */
async function endpointsOf(container: Docker.Container, host: string): Promise<Record<string, string>> {
  const ports = (await container.inspect()).NetworkSettings.Ports ?? {};
  const out: Record<string, string> = {};
  for (const [key, bindings] of Object.entries(ports)) {
    const hostPort = bindings?.[0]?.HostPort;
    if (hostPort) out[key] = `${host}:${hostPort}`;
  }
  return out;
}

function canConnect(endpoint: string): Promise<boolean> {
  const i = endpoint.lastIndexOf(":");
  return new Promise((resolve) => {
    const socket = connect({ host: endpoint.slice(0, i), port: Number(endpoint.slice(i + 1)) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(800, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
