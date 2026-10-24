import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import type Docker from "dockerode";
import type { ContainerInfo } from "dockerode";
import type { PluginContext, SavedConnection, Task } from "@oneclient/plugin-api";
import { describeDockerError } from "./errors.js";
import { hostAddress, requireSession } from "./sessions.js";
import {
  type Bindings,
  type ContainerTemplate,
  TEMPLATES_POINT,
  connectionConfig,
  createOptions,
  freeName,
  freePort,
  generatePassword,
  linkedConnections,
  matchTemplate,
  normalizeTemplates,
  publishedPorts,
  templateKey,
  variablesFromContainer,
} from "./templates.js";

/**
 * "Infrastructure for testing": runs the containers other plugins describe (templates.ts), waits until the owning
 * plugin can really connect, and saves that connection — plus telling which existing containers belong to which plugin.
 */
export class Infrastructure {
  constructor(private readonly context: PluginContext) {}

  async templates(): Promise<ContainerTemplate[]> {
    return normalizeTemplates(await this.context.contributions.get(TEMPLATES_POINT));
  }

  async find(key: string): Promise<ContainerTemplate> {
    const t = (await this.templates()).find((x) => templateKey(x) === key);
    if (!t) throw new Error(`No container template "${key}" — is its plugin installed and enabled?`);
    return t;
  }

  /** Each container with the template it matches and the saved connections that point at it. */
  async annotate(containers: ContainerInfo[]): Promise<Map<string, { template: ContainerTemplate; connections: SavedConnection[] }>> {
    const [templates, connections] = await Promise.all([this.templates(), this.context.connections.list()]);
    const out = new Map<string, { template: ContainerTemplate; connections: SavedConnection[] }>();
    for (const c of containers) {
      const template = matchTemplate({ image: c.Image, labels: c.Labels }, templates);
      if (template) out.set(c.Id, { template, connections: linkedConnections(template, publishedPorts(c.Ports), connections) });
    }
    return out;
  }

  /** The templates with ready-to-use defaults for this Docker host: free host ports, an unused name, generated secrets. */
  async catalog(connectionId: string) {
    const client = requireSession(connectionId);
    const [templates, containers] = await Promise.all([this.templates(), client.listContainers({ all: true })]);
    const takenNames = new Set(containers.flatMap((c) => c.Names.map((n) => n.replace(/^\//, ""))));
    const takenPorts = new Set(containers.flatMap((c) => (c.Ports ?? []).map((p) => p.PublicPort).filter((p): p is number => !!p)));
    const local = hostAddress(connectionId) === "127.0.0.1";
    const annotations = await this.annotate(containers);
    const items = [];
    for (const t of templates) {
      const ports: Record<string, number> = {};
      for (const p of t.ports) {
        let port = freePort(p.host, takenPorts);
        // Something outside Docker may hold it too (a locally installed PostgreSQL); only checkable for a local engine.
        while (local && !(await isPortFree(port))) port = freePort(port + 1, takenPorts);
        takenPorts.add(port);
        ports[p.container] = port;
      }
      const variables: Record<string, string> = {};
      for (const [name, v] of Object.entries(t.variables ?? {})) variables[name] = v.default ?? (v.secret ? generatePassword((n) => randomBytes(n)) : "");
      const running = containers.filter((c) => annotations.get(c.Id)?.template === t).map((c) => ({ id: c.Id, name: c.Names[0]?.replace(/^\//, "") ?? c.Id, state: c.State }));
      items.push({
        key: templateKey(t),
        pluginId: t.pluginId,
        title: t.title,
        product: t.product ?? t.title,
        description: t.description ?? "",
        icon: t.icon ?? "",
        image: t.image,
        typeId: t.connection.typeId,
        ports: t.ports.map((p) => ({ container: p.container, label: p.label ?? p.container, host: ports[p.container]! })),
        variables: Object.entries(t.variables ?? {}).map(([name, v]) => ({ name, label: v.label ?? name, description: v.description ?? "", secret: !!v.secret, value: variables[name]! })),
        name: freeName(`oneclient-${t.id}`, takenNames),
        connectionName: t.connection.name ?? `Local ${t.product ?? t.title}`,
        existing: running,
      });
    }
    return items;
  }

  /** Pull (if needed) → create → start → wait for the connection test → save the connection. Runs as a background task. */
  async run(args: {
    connectionId: string;
    template: string;
    name: string;
    ports: Record<string, number>;
    variables: Record<string, string>;
    connectionName: string;
  }): Promise<{ containerId: string; connectionId: string; message: string }> {
    const client = requireSession(args.connectionId);
    const t = await this.find(args.template);
    const bindings: Bindings = { host: hostAddress(args.connectionId), name: args.name.trim(), ports: args.ports, variables: args.variables };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(bindings.name)) throw new Error("Container names use letters, digits, '_', '.' and '-', and start with a letter or digit.");

    return this.context.tasks.run({ title: `Start ${t.title} (${bindings.name})`, cancellable: true }, async (task) => {
      const stopIfCancelled = () => {
        if (task.isCancelled) throw new Error("Stopped.");
      };
      if (!(await hasImage(client, t.image))) await pull(client, t.image, task);
      stopIfCancelled();

      task.report({ detail: "Creating the container…" });
      const container = await client.createContainer(createOptions(t, bindings));
      task.log(`Created container ${bindings.name} (${container.id.slice(0, 12)}) from ${t.image}\n`);
      await container.start();
      task.log(`Started. Published ${Object.entries(bindings.ports).map(([c, h]) => `${bindings.host}:${h} → ${c}`).join(", ")}\n`);

      const config = connectionConfig(t, bindings);
      const started = Date.now();
      const deadline = started + (t.startupSeconds ?? 120) * 1000;
      let lastMessage = "";
      for (;;) {
        stopIfCancelled();
        const state = (await container.inspect()).State;
        if (!state.Running) {
          const logs = await tailLogs(container);
          throw new Error(`The container stopped (exit code ${state.ExitCode}).${logs ? `\n\nLast log lines:\n${logs}` : ""}`);
        }
        const result = await this.context.connections.test(t.connection.typeId, config);
        if (result.success) break;
        lastMessage = result.message ?? "";
        if (Date.now() > deadline) {
          throw new Error(`${t.product ?? t.title} didn't accept connections within ${t.startupSeconds ?? 120}s${lastMessage ? `: ${lastMessage}` : "."} The container "${bindings.name}" is still running.`);
        }
        const seconds = Math.round((Date.now() - started) / 1000);
        task.report({ detail: `Waiting for ${t.product ?? t.title} to accept connections… ${seconds}s` });
        await sleep(2000);
      }

      const { id } = await this.context.connections.create({ typeId: t.connection.typeId, name: args.connectionName.trim() || bindings.name, config });
      const message = `${t.product ?? t.title} is running in "${bindings.name}" and connection "${args.connectionName}" is ready.`;
      task.log(`${message}\n`);
      return { containerId: container.id, connectionId: id, message };
    });
  }

  /** Saves a connection to a container that wasn't started here (or whose connection was deleted). */
  async connectExisting(connectionId: string, containerId: string): Promise<{ connectionId: string; message: string }> {
    const client = requireSession(connectionId);
    const info = await client.getContainer(containerId).inspect();
    const templates = await this.templates();
    const t = matchTemplate({ image: info.Config.Image, labels: info.Config.Labels }, templates);
    if (!t) throw new Error(`No installed plugin recognises the image "${info.Config.Image}".`);
    if (!info.State.Running) throw new Error("Start the container first.");
    const ports: Record<string, number> = {};
    for (const [key, bindings] of Object.entries(info.NetworkSettings.Ports ?? {})) {
      const hostPort = Number(bindings?.[0]?.HostPort);
      if (hostPort) ports[key] = hostPort;
    }
    if (t.ports.some((p) => !ports[p.container])) {
      throw new Error(`The container doesn't publish ${t.ports.filter((p) => !ports[p.container]).map((p) => p.container).join(", ")} to the host, so oneClient can't reach it.`);
    }
    const name = info.Name.replace(/^\//, "");
    const config = connectionConfig(t, { host: hostAddress(connectionId), name, ports, variables: variablesFromContainer(t, info.Config) });
    const result = await this.context.connections.test(t.connection.typeId, config);
    const { id } = await this.context.connections.create({ typeId: t.connection.typeId, name, config });
    return {
      connectionId: id,
      message: result.success
        ? `Added ${t.product ?? t.title} connection "${name}".`
        : `Added ${t.product ?? t.title} connection "${name}", but its test failed (${result.message ?? "no details"}) — edit its settings if the container uses other credentials.`,
    };
  }
}

async function hasImage(client: Docker, image: string): Promise<boolean> {
  try {
    await client.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

interface PullEvent {
  id?: string;
  status?: string;
  progressDetail?: { current?: number; total?: number };
}

/** `docker pull` with the layers' combined download progress shown on the task. */
export async function pull(client: Docker, image: string, task: Task): Promise<void> {
  task.report({ detail: `Pulling ${image}…`, progress: 0 });
  task.log(`Pulling ${image}\n`);
  const layers = new Map<string, { current: number; total: number }>();
  await new Promise<void>((resolve, reject) => {
    client.pull(image, (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err || !stream) return reject(new Error(describeDockerError(err ?? new Error("No pull stream returned."))));
      task.onCancel(() => (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.());
      client.modem.followProgress(
        stream,
        (err2: Error | null) => (err2 ? reject(new Error(describeDockerError(err2))) : resolve()),
        (event: PullEvent) => {
          if (!event.id) {
            if (event.status) task.log(`${event.status}\n`);
            return;
          }
          const layer = layers.get(event.id) ?? { current: 0, total: 0 };
          if (event.status === "Downloading" && event.progressDetail?.total) {
            layer.current = event.progressDetail.current ?? 0;
            layer.total = event.progressDetail.total;
          } else if (event.status === "Download complete" || event.status === "Pull complete" || event.status === "Already exists") {
            layer.current = layer.total = Math.max(layer.total, 1);
          }
          layers.set(event.id, layer);
          if (event.status === "Pull complete" || event.status === "Already exists") task.log(`${event.id}: ${event.status}\n`);
          let current = 0;
          let total = 0;
          for (const l of layers.values()) {
            current += l.current;
            total += l.total;
          }
          if (total > 0) task.report({ detail: `Pulling ${image}… ${Math.floor((current / total) * 100)}%`, progress: Math.min(current / total, 1) });
        },
      );
    });
  });
}

async function tailLogs(container: Docker.Container): Promise<string> {
  try {
    const buffer = (await container.logs({ stdout: true, stderr: true, tail: 20 })) as unknown as Buffer;
    // Multiplexed stream frames: 8-byte headers before each chunk.
    const lines: string[] = [];
    for (let i = 0; i + 8 <= buffer.length; ) {
      const size = buffer.readUInt32BE(i + 4);
      lines.push(buffer.subarray(i + 8, i + 8 + size).toString("utf8"));
      i += 8 + size;
    }
    return (lines.length ? lines.join("") : buffer.toString("utf8")).trim();
  } catch {
    return "";
  }
}

/**
 * Whether nothing answers on 127.0.0.1:port. Probes by connecting rather than listening: opening a listening socket
 * makes Windows Firewall ask the user to allow the app.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (free: boolean) => {
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(400, () => done(true));
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
