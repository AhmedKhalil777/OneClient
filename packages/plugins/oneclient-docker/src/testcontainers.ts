import type Docker from "dockerode";

/**
 * Test containers: a throwaway container for a scenario no template covers — any image, with the ports, environment,
 * command and readiness check you choose, in the spirit of Testcontainers. Everything here is pure (no Docker calls)
 * except `waitFor`'s probes, which are injected, so it is unit-tested directly.
 */
export const TEST_LABEL = "oneclient.testcontainer";
export const TEST_EXPIRES_LABEL = "oneclient.testcontainer.expires";

export type WaitStrategy = { kind: "none" } | { kind: "port" } | { kind: "log"; message: string } | { kind: "healthy" };

export interface PortSpec {
  /** Port inside the container, e.g. "8080/tcp". */
  container: string;
  /** Fixed host port, or 0 to let Docker pick a free one. */
  host: number;
}

export interface TestContainerRequest {
  image: string;
  name: string;
  /** One `HOST:CONTAINER[/proto]` or `CONTAINER[/proto]` per line/entry. */
  ports: string[];
  /** `KEY=VALUE` per line. */
  env: string;
  /** A shell-like command line; empty keeps the image's default. */
  cmd: string;
  wait: WaitStrategy;
  /** Seconds to wait for readiness. */
  timeoutSeconds: number;
  /** Remove the container this many minutes after it starts; 0 keeps it. */
  ttlMinutes: number;
  /** Remove the container as soon as it exits. */
  autoRemove: boolean;
}

/** `8080`, `8080/udp`, `9090:8080`, `9090:8080/tcp` → host 0 (random) or fixed. */
export function parsePort(spec: string): PortSpec {
  const m = /^\s*(?:(\d{1,5}):)?(\d{1,5})(?:\/(tcp|udp))?\s*$/i.exec(spec);
  if (!m) throw new Error(`Invalid port "${spec.trim()}" — use 8080, 9090:8080 or 8080/udp.`);
  const host = m[1] ? Number(m[1]) : 0;
  const container = Number(m[2]);
  if (host > 65535 || container < 1 || container > 65535) throw new Error(`Port out of range in "${spec.trim()}".`);
  return { container: `${container}/${(m[3] ?? "tcp").toLowerCase()}`, host };
}

export function parsePorts(specs: string[]): PortSpec[] {
  return specs.filter((s) => s.trim()).map(parsePort);
}

/** `KEY=VALUE` lines → Docker's `Env` array. Blank lines and `#` comments are skipped. */
export function parseEnv(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*=/.test(line)) throw new Error(`Invalid environment line "${line}" — use KEY=VALUE.`);
    out.push(line);
  }
  return out;
}

/** Splits a command line into arguments, honouring single and double quotes. */
export function parseCommand(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of text.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) args.push(current);
      current = "";
      has = false;
    } else {
      current += ch;
    }
  }
  if (quote) throw new Error("Unterminated quote in the command.");
  if (has || current) args.push(current);
  return args;
}

export function validateRequest(r: TestContainerRequest): void {
  if (!r.image.trim()) throw new Error("Enter an image, e.g. nginx:alpine.");
  if (r.name.trim() && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(r.name.trim())) {
    throw new Error("Container names use letters, digits, '_', '.' and '-', and start with a letter or digit.");
  }
  if (r.wait.kind === "log" && !r.wait.message.trim()) throw new Error("Enter the log text to wait for.");
  if (r.wait.kind === "port" && parsePorts(r.ports).length === 0) throw new Error("Waiting for a port needs at least one published port.");
}

/** The `createContainer` options for a request. `now` is injected for tests. */
export function createTestOptions(r: TestContainerRequest, now = Date.now()): Docker.ContainerCreateOptions {
  const ports = parsePorts(r.ports);
  const cmd = parseCommand(r.cmd);
  const labels: Record<string, string> = { [TEST_LABEL]: "true" };
  if (r.ttlMinutes > 0) labels[TEST_EXPIRES_LABEL] = String(now + r.ttlMinutes * 60_000);
  const exposed: Record<string, object> = {};
  const bindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const p of ports) {
    exposed[p.container] = {};
    bindings[p.container] = [{ HostPort: p.host ? String(p.host) : "" }];
  }
  return {
    ...(r.name.trim() ? { name: r.name.trim() } : {}),
    Image: r.image.trim(),
    Env: parseEnv(r.env),
    ...(cmd.length ? { Cmd: cmd } : {}),
    Labels: labels,
    ExposedPorts: exposed,
    HostConfig: { PortBindings: bindings, AutoRemove: r.autoRemove },
  };
}

/** Whether a container carries the test label and (if it has a TTL) is past it. */
export function isExpired(labels: Record<string, string> | undefined, now = Date.now()): boolean {
  const at = Number(labels?.[TEST_EXPIRES_LABEL]);
  return !!labels?.[TEST_LABEL] && Number.isFinite(at) && at > 0 && now >= at;
}

export interface Probes {
  /** Current container state: running?, health ("healthy" | "unhealthy" | "starting" | undefined). */
  state(): Promise<{ running: boolean; exitCode?: number | undefined; health?: string | undefined }>;
  /** Logs so far. */
  logs(): Promise<string>;
  /** Whether a TCP connection to every published port succeeds. */
  portsOpen(): Promise<boolean>;
}

/** Polls until the strategy is satisfied; throws if the container dies or the timeout passes. */
export async function waitFor(
  wait: WaitStrategy,
  probes: Probes,
  timeoutMs: number,
  opts: { sleep?: (ms: number) => Promise<void>; now?: () => number; onTick?: (elapsedMs: number) => void } = {},
): Promise<void> {
  if (wait.kind === "none") return;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  for (;;) {
    const state = await probes.state();
    if (!state.running) throw new Error(`The container stopped (exit code ${state.exitCode ?? "?"}) before it was ready.`);
    if (wait.kind === "log" && (await probes.logs()).includes(wait.message)) return;
    if (wait.kind === "port" && (await probes.portsOpen())) return;
    if (wait.kind === "healthy") {
      if (state.health === "healthy") return;
      if (state.health === "unhealthy") throw new Error("The container's health check reports unhealthy.");
      if (state.health === undefined && now() - started > 2000) throw new Error("The image defines no health check — pick another wait strategy.");
    }
    if (now() - started > timeoutMs) {
      throw new Error(`Not ready within ${Math.round(timeoutMs / 1000)}s. The container is still running so you can inspect it.`);
    }
    opts.onTick?.(now() - started);
    await sleep(1000);
  }
}
