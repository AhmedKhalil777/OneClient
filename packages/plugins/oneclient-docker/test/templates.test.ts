import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ContainerTemplate,
  TEMPLATES_POINT,
  connectionConfig,
  createOptions,
  freeName,
  freePort,
  generatePassword,
  imageRepository,
  linkedConnections,
  matchTemplate,
  normalizeTemplates,
  publishedPorts,
  substitute,
  templateKey,
  variablesFromContainer,
} from "../src/templates.js";

/** The templates the bundled plugins really contribute — what the Docker plugin receives from core. */
function contributed(): ContainerTemplate[] {
  const plugins = ["oneclient-postgres", "oneclient-mssql", "oneclient-redis", "oneclient-kafka", "oneclient-azure-blob", "oneclient-keycloak"];
  const raw = plugins.flatMap((dir) => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", dir, "oneclient.json"), "utf8"));
    return (manifest.contributes.extensions?.[TEMPLATES_POINT] ?? []).map((t: object) => ({ ...t, pluginId: manifest.name }));
  });
  return normalizeTemplates(raw);
}

const byId = (id: string) => contributed().find((t) => t.id === id)!;
const local = (ports: Record<string, number>, variables: Record<string, string> = {}) => ({ host: "127.0.0.1", name: "oc-test", ports, variables });

describe("contributed templates", () => {
  it("every infrastructure plugin contributes a well-formed template", () => {
    expect(contributed().map((t) => t.id).sort()).toEqual(["azurite", "kafka", "keycloak", "mssql", "postgres", "redis"]);
  });

  it("each one resolves to a connection with no placeholders left", () => {
    for (const t of contributed()) {
      const ports = Object.fromEntries(t.ports.map((p) => [p.container, p.host + 1]));
      const variables = Object.fromEntries(Object.keys(t.variables ?? {}).map((k) => [k, `v-${k}`]));
      const b = local(ports, variables);
      expect(JSON.stringify(connectionConfig(t, b)), t.id).not.toMatch(/\$\{/);
      expect(JSON.stringify(createOptions(t, b)), t.id).not.toMatch(/\$\{/);
    }
  });

  it("PostgreSQL: env carries the password, the connection gets a numeric port", () => {
    const t = byId("postgres");
    const b = local({ "5432/tcp": 15432 }, { password: "s3cret" });
    expect(createOptions(t, b).Env).toContain("POSTGRES_PASSWORD=s3cret");
    expect(createOptions(t, b).HostConfig.PortBindings).toEqual({ "5432/tcp": [{ HostPort: "15432" }] });
    expect(createOptions(t, b).Labels["oneclient.template"]).toBe("oneclient-postgres/postgres");
    expect(connectionConfig(t, b)).toMatchObject({ host: "127.0.0.1", port: 15432, user: "postgres", password: "s3cret" });
  });

  it("Kafka advertises the host port it is published on", () => {
    const t = byId("kafka");
    const b = local({ "19092/tcp": 29092 });
    expect(createOptions(t, b).Env).toContain("KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://localhost:9092,EXTERNAL://127.0.0.1:29092");
    expect(connectionConfig(t, b)).toMatchObject({ brokers: "127.0.0.1:29092" });
  });

  it("SQL Server and Keycloak build their own address formats", () => {
    expect(connectionConfig(byId("mssql"), local({ "1433/tcp": 14333 }, { password: "P" }))).toMatchObject({ server: "127.0.0.1,14333", user: "sa" });
    expect(connectionConfig(byId("keycloak"), local({ "8080/tcp": 18080 }, { username: "admin", password: "P" }))).toMatchObject({ serverUrl: "http://127.0.0.1:18080", username: "admin" });
    expect(connectionConfig(byId("azurite"), local({ "10000/tcp": 10001 }))).toMatchObject({ endpoint: "http://127.0.0.1:10001/devstoreaccount1" });
  });
});

describe("matching existing containers", () => {
  const templates = contributed();
  const match = (image: string, labels?: Record<string, string>) => matchTemplate({ image, ...(labels ? { labels } : {}) }, templates)?.id;

  it("recognises official images and common variants", () => {
    expect(match("postgres:17")).toBe("postgres");
    expect(match("docker.io/library/postgres:16-alpine")).toBe("postgres");
    expect(match("postgis/postgis:16-3.4")).toBe("postgres");
    expect(match("mcr.microsoft.com/mssql/server:2022-latest")).toBe("mssql");
    expect(match("redis:latest")).toBe("redis");
    expect(match("apache/kafka:latest")).toBe("kafka");
    expect(match("mcr.microsoft.com/azure-storage/azurite")).toBe("azurite");
    expect(match("quay.io/keycloak/keycloak:24.0.2")).toBe("keycloak");
  });

  it("doesn't confuse look-alike names", () => {
    expect(match("nginx:latest")).toBeUndefined();
    expect(match("postgres-exporter:1")).toBeUndefined();
    expect(match("someone/redis-commander")).toBeUndefined();
  });

  it("prefers the label of the template that started it", () => {
    expect(match("custom/image:1", { "oneclient.template": "oneclient-redis/redis" })).toBe("redis");
  });

  it("finds the saved connections pointing at a container's published ports", () => {
    const t = byId("postgres");
    const ports = publishedPorts([{ PrivatePort: 5432, PublicPort: 15432, Type: "tcp" }, { PrivatePort: 5432, Type: "tcp" }]);
    expect(ports).toEqual({ "5432/tcp": 15432 });
    const conns = [
      { id: "a", name: "Shop", typeId: "postgres", pluginId: "oneclient-postgres", config: { host: "localhost", port: 15432 } },
      { id: "b", name: "Other", typeId: "postgres", pluginId: "oneclient-postgres", config: { host: "localhost", port: 5432 } },
      { id: "c", name: "Redis", typeId: "redis", pluginId: "oneclient-redis", config: { port: 15432 } },
    ];
    expect(linkedConnections(t, ports, conns).map((c) => c.id)).toEqual(["a"]);
    // Ports inside address strings count too.
    expect(linkedConnections(byId("mssql"), { "1433/tcp": 14333 }, [{ id: "m", name: "M", typeId: "mssql", pluginId: "x", config: { server: "localhost,14333" } }])).toHaveLength(1);
    expect(linkedConnections(byId("keycloak"), { "8080/tcp": 18080 }, [{ id: "k", name: "K", typeId: "keycloak", pluginId: "x", config: { serverUrl: "http://localhost:18080/" } }])).toHaveLength(1);
  });

  it("reads credentials back from env and command line", () => {
    expect(variablesFromContainer(byId("postgres"), { Env: ["PATH=/usr/bin", "POSTGRES_PASSWORD=pw=1"] })).toEqual({ password: "pw=1" });
    expect(variablesFromContainer(byId("redis"), { Cmd: ["redis-server", "--requirepass", "OneClient!Redis1", "--appendonly", "no"] })).toEqual({ password: "OneClient!Redis1" });
    // Keycloak 24 used KEYCLOAK_ADMIN*; the username falls back to its default.
    expect(variablesFromContainer(byId("keycloak"), { Env: ["KEYCLOAK_ADMIN_PASSWORD=x"] })).toEqual({ username: "admin", password: "x" });
  });
});

describe("helpers", () => {
  it("imageRepository strips tags and digests but keeps registry ports", () => {
    expect(imageRepository("postgres:17")).toBe("postgres");
    expect(imageRepository("localhost:5000/team/db:1.2")).toBe("localhost:5000/team/db");
    expect(imageRepository("redis@sha256:abc")).toBe("redis");
  });

  it("substitute leaves unknown placeholders and keeps non-port values as strings", () => {
    const t = byId("postgres");
    expect(substitute({ a: "${nope}", b: "${port}", c: "x${port}" }, t, local({ "5432/tcp": 1 }))).toEqual({ a: "${nope}", b: 1, c: "x1" });
  });

  it("free ports, names and generated passwords", () => {
    expect(freePort(5432, new Set([5432, 5433]))).toBe(5434);
    expect(freeName("oneclient-redis", new Set(["oneclient-redis", "oneclient-redis-2"]))).toBe("oneclient-redis-3");
    const pw = generatePassword((n) => new Uint8Array(n).map((_, i) => i * 7));
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/\d/);
    expect(pw).toMatch(/[^A-Za-z0-9]/);
    expect(pw.length).toBeGreaterThanOrEqual(12);
  });

  it("normalizeTemplates drops malformed entries", () => {
    const good = { ...byId("redis") };
    expect(normalizeTemplates([good, { id: "x" }, null, { ...good, ports: [{ container: "1/tcp", host: "no" }] }])).toHaveLength(1);
    expect(templateKey(good)).toBe("oneclient-redis/redis");
  });
});
