import Docker from "dockerode";

export interface DockerConnectionConfig {
  host?: string;
}

/**
 * No `host` → dockerode's own default (Unix socket on macOS/Linux,
 * `\\.\pipe\docker_engine` on Windows), which is what most users want for
 * "just talk to my local Docker Desktop." `host` set → treated as a plain
 * (non-TLS) remote Docker Engine API, e.g. "tcp://192.168.1.10:2375".
 */
export function createDockerClient(config: DockerConnectionConfig): Docker {
  const host = config.host?.trim();
  if (!host) return new Docker();

  const url = new URL(host.includes("://") ? host : `tcp://${host}`);
  return new Docker({
    protocol: url.protocol === "https:" ? "https" : "http",
    host: url.hostname,
    port: url.port ? Number(url.port) : 2375,
  });
}
