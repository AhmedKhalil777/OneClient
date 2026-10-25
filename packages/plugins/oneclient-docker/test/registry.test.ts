import { describe, expect, it } from "vitest";
import { fetchTags, hubRepository, matchLocal, normalizeSearch, normalizeTags, tagsUrl } from "../src/registry.js";

describe("hubRepository", () => {
  it("maps names to Docker Hub repositories", () => {
    expect(hubRepository("nginx")).toBe("library/nginx");
    expect(hubRepository("nginx:alpine")).toBe("library/nginx");
    expect(hubRepository("bitnami/redis:7")).toBe("bitnami/redis");
    expect(hubRepository("docker.io/library/postgres:16")).toBe("library/postgres");
    expect(hubRepository("redis@sha256:abc")).toBe("library/redis");
  });
  it("gives up on other registries", () => {
    expect(hubRepository("ghcr.io/org/app:1")).toBeNull();
    expect(hubRepository("localhost:5000/app")).toBeNull();
    expect(hubRepository("")).toBeNull();
  });
});

describe("search and tags", () => {
  it("sorts official first, then by stars", () => {
    const r = normalizeSearch([
      { name: "a/pg", star_count: 500, description: "x" },
      { name: "postgres", star_count: 10, is_official: true },
      { name: "b/pg", star_count: 900 },
      { junk: true },
    ]);
    expect(r.map((x) => x.name)).toEqual(["postgres", "b/pg", "a/pg"]);
    expect(normalizeSearch(null)).toEqual([]);
  });
  it("reads tags", () => {
    const tags = normalizeTags({ results: [{ name: "16", last_updated: "2025-01-01T00:00:00Z", images: [{ size: 5 }] }, { name: "latest" }, {}] });
    expect(tags).toEqual([
      { name: "16", size: 5, updated: "2025-01-01T00:00:00Z" },
      { name: "latest", size: null, updated: null },
    ]);
  });
  it("fetches via the injected function and explains other registries", async () => {
    let url = "";
    const r = await fetchTags("redis:7", async (u) => ((url = u), { results: [{ name: "7" }] }));
    expect(url).toBe(tagsUrl("library/redis"));
    expect(r.tags[0]!.name).toBe("7");
    expect((await fetchTags("ghcr.io/x/y", async () => ({}))).note).toMatch(/Docker Hub/);
  });
  it("filters local images", () => {
    expect(matchLocal(["nginx:alpine", "<none>:<none>", "postgres:16", "nginx:alpine"], "NGI")).toEqual(["nginx:alpine"]);
    expect(matchLocal(["b:1", "a:1"], "")).toEqual(["a:1", "b:1"]);
  });
});
