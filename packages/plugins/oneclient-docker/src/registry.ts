/**
 * Finding images the way a package manager does: search the registry (Docker Hub, through the engine's own search),
 * then pick a tag. Pure helpers plus two fetchers that take their I/O as parameters so they can be tested.
 */
export interface HubResult {
  name: string;
  description: string;
  stars: number;
  official: boolean;
}

export interface TagInfo {
  name: string;
  /** Compressed size in bytes of the first image listed, when known. */
  size: number | null;
  updated: string | null;
}

/** `nginx` → `library/nginx`; `bitnami/redis:7` → `bitnami/redis`; null for images on another registry (`ghcr.io/…`). */
export function hubRepository(image: string): string | null {
  const repo = image.trim().replace(/@sha256:.*$/, "").replace(/:[^/:]*$/, "");
  if (!repo) return null;
  const parts = repo.split("/");
  const first = parts[0]!;
  const hasHost = parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasHost) return first === "docker.io" || first === "registry-1.docker.io" ? hubRepository(parts.slice(1).join("/")) : null;
  return parts.length === 1 ? `library/${repo}` : repo;
}

export function tagsUrl(repository: string, pageSize = 30): string {
  return `https://hub.docker.com/v2/repositories/${repository}/tags?page_size=${pageSize}&ordering=last_updated`;
}

/** What the engine's `GET /images/search` returns, reduced to what the picker shows. */
export function normalizeSearch(raw: unknown): HubResult[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as { name?: unknown }).name === "string")
    .map((r) => ({
      name: String(r.name),
      description: typeof r.description === "string" ? r.description : "",
      stars: typeof r.star_count === "number" ? r.star_count : 0,
      official: r.is_official === true,
    }))
    .sort((a, b) => Number(b.official) - Number(a.official) || b.stars - a.stars);
}

export function normalizeTags(raw: unknown): TagInfo[] {
  const results = (raw as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string")
    .map((t) => {
      const images = Array.isArray(t.images) ? (t.images as Array<{ size?: unknown }>) : [];
      const size = images.find((i) => typeof i.size === "number")?.size;
      return { name: String(t.name), size: typeof size === "number" ? size : null, updated: typeof t.last_updated === "string" ? t.last_updated : null };
    });
}

export async function fetchTags(image: string, fetchJson: (url: string) => Promise<unknown>): Promise<{ tags: TagInfo[]; note?: string }> {
  const repo = hubRepository(image);
  if (!repo) return { tags: [], note: "Tags can only be listed for Docker Hub images." };
  return { tags: normalizeTags(await fetchJson(tagsUrl(repo))) };
}

/** Local images whose tag mentions the term (case-insensitive), as `repo:tag`. */
export function matchLocal(tags: string[], term: string): string[] {
  const t = term.trim().toLowerCase();
  return [...new Set(tags.filter((x) => x && !x.startsWith("<none>") && (!t || x.toLowerCase().includes(t))))].sort();
}
