import { describe, expect, it } from "vitest";
import {
  type TestContainerRequest,
  type Probes,
  TEST_EXPIRES_LABEL,
  TEST_LABEL,
  createTestOptions,
  isExpired,
  parseCommand,
  parseEnv,
  parsePort,
  validateRequest,
  waitFor,
} from "../src/testcontainers.js";

const base: TestContainerRequest = { image: "nginx:alpine", name: "", ports: [], env: "", cmd: "", wait: { kind: "none" }, timeoutSeconds: 30, ttlMinutes: 0, autoRemove: false };

describe("parsePort", () => {
  it("handles random, fixed and protocol forms", () => {
    expect(parsePort("8080")).toEqual({ container: "8080/tcp", host: 0 });
    expect(parsePort("9090:8080/UDP")).toEqual({ container: "8080/udp", host: 9090 });
  });
  it("rejects junk and out-of-range", () => {
    expect(() => parsePort("abc")).toThrow();
    expect(() => parsePort("70000")).toThrow();
  });
});

describe("parseEnv / parseCommand", () => {
  it("skips blanks and comments, rejects bad lines", () => {
    expect(parseEnv("A=1\n\n# x\nB=two words\r\n")).toEqual(["A=1", "B=two words"]);
    expect(() => parseEnv("nope")).toThrow();
  });
  it("splits quoted arguments", () => {
    expect(parseCommand(`sh -c "echo hi there" 'a b' ""`)).toEqual(["sh", "-c", "echo hi there", "a b", ""]);
    expect(parseCommand("  ")).toEqual([]);
    expect(() => parseCommand('echo "x')).toThrow();
  });
});

describe("createTestOptions", () => {
  it("labels, binds ports (random when 0) and sets a TTL", () => {
    const o = createTestOptions({ ...base, name: "t1", ports: ["8080", "9000:9001"], cmd: "nginx -g 'daemon off;'", ttlMinutes: 5, autoRemove: true }, 1000);
    expect(o.name).toBe("t1");
    expect(o.Cmd).toEqual(["nginx", "-g", "daemon off;"]);
    expect(o.Labels).toEqual({ [TEST_LABEL]: "true", [TEST_EXPIRES_LABEL]: String(1000 + 300_000) });
    expect(o.HostConfig?.PortBindings).toEqual({ "8080/tcp": [{ HostPort: "" }], "9001/tcp": [{ HostPort: "9000" }] });
    expect(o.HostConfig?.AutoRemove).toBe(true);
  });
  it("omits name/cmd/expiry when unset", () => {
    const o = createTestOptions(base);
    expect(o.name).toBeUndefined();
    expect(o.Cmd).toBeUndefined();
    expect(o.Labels).toEqual({ [TEST_LABEL]: "true" });
  });
});

describe("validateRequest / isExpired", () => {
  it("validates", () => {
    expect(() => validateRequest({ ...base, image: " " })).toThrow();
    expect(() => validateRequest({ ...base, name: "-bad" })).toThrow();
    expect(() => validateRequest({ ...base, wait: { kind: "port" } })).toThrow();
    expect(() => validateRequest({ ...base, wait: { kind: "log", message: "" } })).toThrow();
    expect(() => validateRequest(base)).not.toThrow();
  });
  it("expires only labelled containers past their TTL", () => {
    expect(isExpired({ [TEST_LABEL]: "true", [TEST_EXPIRES_LABEL]: "100" }, 99)).toBe(false);
    expect(isExpired({ [TEST_LABEL]: "true", [TEST_EXPIRES_LABEL]: "100" }, 100)).toBe(true);
    expect(isExpired({ [TEST_EXPIRES_LABEL]: "100" }, 200)).toBe(false);
    expect(isExpired({ [TEST_LABEL]: "true" }, 200)).toBe(false);
  });
});

describe("waitFor", () => {
  const fast = () => {
    let t = 0;
    return { sleep: async (ms: number) => void (t += ms), now: () => t };
  };
  const probes = (over: Partial<Probes>): Probes => ({ state: async () => ({ running: true }), logs: async () => "", portsOpen: async () => false, ...over });

  it("resolves when the log line appears", async () => {
    let n = 0;
    await waitFor({ kind: "log", message: "ready" }, probes({ logs: async () => (++n > 2 ? "server ready" : "") }), 10_000, fast());
    expect(n).toBe(3);
  });
  it("fails if the container dies", async () => {
    await expect(waitFor({ kind: "port" }, probes({ state: async () => ({ running: false, exitCode: 3 }) }), 10_000, fast())).rejects.toThrow(/exit code 3/);
  });
  it("times out", async () => {
    await expect(waitFor({ kind: "port" }, probes({}), 3000, fast())).rejects.toThrow(/Not ready within 3s/);
  });
  it("healthy: waits, rejects unhealthy and missing healthcheck", async () => {
    await waitFor({ kind: "healthy" }, probes({ state: async () => ({ running: true, health: "healthy" }) }), 5000, fast());
    await expect(waitFor({ kind: "healthy" }, probes({ state: async () => ({ running: true, health: "unhealthy" }) }), 5000, fast())).rejects.toThrow(/unhealthy/);
    await expect(waitFor({ kind: "healthy" }, probes({}), 60_000, fast())).rejects.toThrow(/no health check/);
  });
});
