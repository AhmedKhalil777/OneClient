import type { SavedConnection } from "@oneclient/plugin-api";

/**
 * Container templates: how to run a piece of infrastructure in Docker and connect to it. They are contributed by the
 * plugin that owns the connection type — the PostgreSQL plugin describes how to start PostgreSQL — under
 * `contributes.extensions["docker.containerTemplates"]`, so installing a plugin adds its template here with no change
 * to this plugin. Everything in this module is pure (no Docker calls), so it is unit-tested directly.
 *
 * Strings in `env`, `cmd` and `connection.config` may use these placeholders:
 *   ${host}               the Docker host's address (127.0.0.1 for a local engine)
 *   ${port}               the host port of the first entry in `ports`;  ${port:5432/tcp}  of a specific one
 *   ${name}               the container name
 *   ${<variable>}         a template variable, e.g. ${password}
 * A value that is exactly one port placeholder becomes a number.
 */
export const TEMPLATES_POINT = "docker.containerTemplates";

/** Where to read a variable back from an existing container (to connect to one oneClient didn't start). */
export type VariableSource = { env: string } | { argAfter: string };

export interface TemplateVariable {
  label?: string;
  description?: string;
  /** A fixed default; omit for secrets to have one generated. */
  default?: string;
  /** Masked in the UI, generated when there is no default, and stored as a secret by the target plugin. */
  secret?: boolean;
  from?: VariableSource[];
}

export interface ContainerTemplate {
  /** The contributing plugin (added by core). */
  pluginId: string;
  /** Unique within its plugin. */
  id: string;
  title: string;
  /** Product name shown next to matching containers ("PostgreSQL"); defaults to `title`. */
  product?: string;
  description?: string;
  /** A registry icon, e.g. "$(postgresql)". */
  icon?: string;
  image: string;
  /** Regular expressions an existing container's image must match to be recognised; defaults to `image`'s repository. */
  imagePatterns?: string[];
  ports: Array<{ container: string; host: number; label?: string }>;
  env?: Record<string, string>;
  cmd?: string[];
  variables?: Record<string, TemplateVariable>;
  connection: { typeId: string; name?: string; config: Record<string, unknown> };
  /** How long to wait for the connection test to pass after the container starts (default 120). */
  startupSeconds?: number;
}

/** A Docker Engine port entry (`listContainers()[].Ports`). */
export interface PortEntry {
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

export const templateKey = (t: Pick<ContainerTemplate, "pluginId" | "id">): string => `${t.pluginId}/${t.id}`;
export const LABEL_TEMPLATE = "oneclient.template";

/** Keeps the well-formed entries of a contribution point; a plugin's typo must not break the others. */
export function normalizeTemplates(raw: unknown[]): ContainerTemplate[] {
  const out: ContainerTemplate[] = [];
  for (const item of raw) {
    const t = item as Partial<ContainerTemplate> | null;
    if (!t || typeof t !== "object") continue;
    if (typeof t.pluginId !== "string" || typeof t.id !== "string" || typeof t.title !== "string" || typeof t.image !== "string") continue;
    if (!Array.isArray(t.ports) || !t.ports.every((p) => p && typeof p.container === "string" && Number.isInteger(p.host))) continue;
    if (!t.connection || typeof t.connection.typeId !== "string" || !t.connection.config || typeof t.connection.config !== "object") continue;
    out.push(t as ContainerTemplate);
  }
  return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `postgres:17` → `postgres`; `mcr.microsoft.com/mssql/server:2022-latest` → `mcr.microsoft.com/mssql/server`. */
export function imageRepository(image: string): string {
  const noDigest = image.split("@")[0]!;
  const lastSlash = noDigest.lastIndexOf("/");
  const colon = noDigest.indexOf(":", lastSlash + 1);
  return colon === -1 ? noDigest : noDigest.slice(0, colon);
}

function imageMatchers(t: ContainerTemplate): RegExp[] {
  const patterns = t.imagePatterns?.length
    ? t.imagePatterns
    : [`^(?:docker\\.io/)?(?:library/)?${escapeRegExp(imageRepository(t.image).replace(/^(?:docker\.io\/)?(?:library\/)?/, ""))}(?:[:@]|$)`];
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      // an invalid pattern from a plugin is ignored
    }
  }
  return out;
}

/** The template a container belongs to: the one that started it (label), else the first whose image matches. */
export function matchTemplate(container: { image: string; labels?: Record<string, string> | null }, templates: ContainerTemplate[]): ContainerTemplate | undefined {
  const label = container.labels?.[LABEL_TEMPLATE];
  if (label) {
    const byLabel = templates.find((t) => templateKey(t) === label);
    if (byLabel) return byLabel;
  }
  return templates.find((t) => imageMatchers(t).some((re) => re.test(container.image)));
}

/** Host ports a container publishes, keyed like the templates' ports ("5432/tcp"). */
export function publishedPorts(ports: PortEntry[] | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of ports ?? []) {
    if (p.PublicPort && !out[`${p.PrivatePort}/${p.Type}`]) out[`${p.PrivatePort}/${p.Type}`] = p.PublicPort;
  }
  return out;
}

export interface Bindings {
  host: string;
  name: string;
  /** Container port ("5432/tcp") → host port. */
  ports: Record<string, number>;
  variables: Record<string, string>;
}

/** Replaces the placeholders in `value` (strings, arrays and objects, recursively). Unknown placeholders stay as they are. */
export function substitute<T>(value: T, t: ContainerTemplate, b: Bindings): T {
  const portOf = (key: string | undefined): number | undefined => {
    const containerPort = key ?? t.ports[0]?.container;
    return containerPort ? b.ports[containerPort] : undefined;
  };
  const one = (s: string): unknown => {
    const exact = /^\$\{port(?::([^}]+))?\}$/.exec(s);
    if (exact) return portOf(exact[1]) ?? s;
    return s.replace(/\$\{([a-zA-Z][\w-]*)(?::([^}]+))?\}/g, (whole, key: string, arg: string | undefined) => {
      if (key === "port") return String(portOf(arg) ?? whole);
      if (key === "host") return b.host;
      if (key === "name") return b.name;
      return b.variables[key] ?? whole;
    });
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return one(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** `docker create` options for running `t` with these bindings. */
export function createOptions(t: ContainerTemplate, b: Bindings): {
  name: string;
  Image: string;
  Env: string[];
  Cmd?: string[];
  Labels: Record<string, string>;
  ExposedPorts: Record<string, Record<string, never>>;
  HostConfig: { PortBindings: Record<string, Array<{ HostPort: string }>> };
} {
  const env = substitute(t.env ?? {}, t, b);
  const cmd = t.cmd ? substitute(t.cmd, t, b) : undefined;
  return {
    name: b.name,
    Image: t.image,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    ...(cmd ? { Cmd: cmd.map(String) } : {}),
    Labels: { [LABEL_TEMPLATE]: templateKey(t), "oneclient.plugin": t.pluginId },
    ExposedPorts: Object.fromEntries(t.ports.map((p) => [p.container, {}])),
    HostConfig: { PortBindings: Object.fromEntries(t.ports.map((p) => [p.container, [{ HostPort: String(b.ports[p.container] ?? p.host) }]])) },
  };
}

/** The target plugin's connection settings for a container started from (or matching) `t`. */
export function connectionConfig(t: ContainerTemplate, b: Bindings): Record<string, unknown> {
  return substitute(t.connection.config, t, b);
}

/** Reads the template's variables back from a container's `Config.Env` / command line. */
export function variablesFromContainer(
  t: ContainerTemplate,
  config: { Env?: string[] | null | undefined; Cmd?: string[] | null | undefined; Entrypoint?: string[] | string | null | undefined },
): Record<string, string> {
  const env = new Map<string, string>();
  for (const entry of config.Env ?? []) {
    const eq = entry.indexOf("=");
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  const args = [...(Array.isArray(config.Entrypoint) ? config.Entrypoint : []), ...(config.Cmd ?? [])];
  const out: Record<string, string> = {};
  for (const [name, variable] of Object.entries(t.variables ?? {})) {
    for (const source of variable.from ?? []) {
      let value: string | undefined;
      if ("env" in source) value = env.get(source.env);
      else {
        const i = args.indexOf(source.argAfter);
        value = i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`${source.argAfter}=`))?.slice(source.argAfter.length + 1);
      }
      if (value) {
        out[name] = value;
        break;
      }
    }
    if (out[name] === undefined && variable.default !== undefined) out[name] = variable.default;
  }
  return out;
}

/** Port numbers mentioned in a connection's settings: numbers, and ":1234" / ",1234" inside strings. */
function portsInConfig(config: Readonly<Record<string, unknown>>): Set<number> {
  const out = new Set<number>();
  for (const value of Object.values(config)) {
    if (typeof value === "number" && Number.isInteger(value)) out.add(value);
    else if (typeof value === "string") {
      if (/^\d{2,5}$/.test(value)) out.add(Number(value));
      for (const m of value.matchAll(/[:,](\d{2,5})(?=$|[/,;?\s])/g)) out.add(Number(m[1]));
    }
  }
  return out;
}

/** Saved connections of the template's type that point at one of the container's published host ports. */
export function linkedConnections(t: ContainerTemplate, ports: Record<string, number>, connections: SavedConnection[]): SavedConnection[] {
  const published = new Set(Object.values(ports));
  if (published.size === 0) return [];
  return connections.filter((c) => c.typeId === t.connection.typeId && [...portsInConfig(c.config)].some((p) => published.has(p)));
}

/** A password Docker images accept — SQL Server's policy wants upper and lower case, a digit and a symbol. */
export function generatePassword(random: (n: number) => Uint8Array): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = random(14);
  let core = "";
  for (const byte of bytes) core += alphabet[byte % alphabet.length];
  return `Oc${core}9!`;
}

/** First port ≥ `preferred` not in `taken`. */
export function freePort(preferred: number, taken: Set<number>): number {
  let port = preferred;
  while (taken.has(port) && port < 65535) port++;
  return port;
}

/** `base`, or `base-2`, `base-3`… — the first name not in `taken`. */
export function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
