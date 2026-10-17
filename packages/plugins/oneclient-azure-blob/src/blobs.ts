import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { BlobSASPermissions, type ContainerClient, type PublicAccessType, generateBlobSASQueryParameters, ContainerSASPermissions } from "@azure/storage-blob";
import { BlobPluginError, type ServiceHandle } from "./client.js";

export interface ContainerRow {
  name: string;
  publicAccess: string;
  lastModified?: string;
  leaseState?: string;
}

export async function listContainers(h: ServiceHandle): Promise<ContainerRow[]> {
  if (h.onlyContainer) return [{ name: h.onlyContainer, publicAccess: "" }];
  const out: ContainerRow[] = [];
  for await (const c of h.service.listContainers()) {
    out.push({
      name: c.name,
      publicAccess: c.properties.publicAccess ?? "private",
      ...(c.properties.lastModified ? { lastModified: c.properties.lastModified.toISOString() } : {}),
      ...(c.properties.leaseState ? { leaseState: c.properties.leaseState } : {}),
    });
    if (out.length >= 2000) break;
  }
  return out;
}

const container = (h: ServiceHandle, name: string): ContainerClient => {
  if (h.onlyContainer && name !== h.onlyContainer) throw new BlobPluginError(`This SAS only grants the container "${h.onlyContainer}".`);
  return h.service.getContainerClient(name);
};

const CONTAINER_NAME = /^(?!-)(?!.*--)[a-z0-9-]{3,63}(?<!-)$/;

export async function createContainer(h: ServiceHandle, name: string, access: string): Promise<void> {
  if (!CONTAINER_NAME.test(name)) throw new BlobPluginError("Container names are 3–63 characters: lower-case letters, numbers and single dashes (not at the start or end).");
  await container(h, name).create(access === "blob" || access === "container" ? { access: access as PublicAccessType } : {});
}

export async function deleteContainer(h: ServiceHandle, name: string): Promise<void> {
  await container(h, name).delete();
}

export async function setContainerAccess(h: ServiceHandle, name: string, access: string): Promise<void> {
  await container(h, name).setAccessPolicy(access === "blob" || access === "container" ? (access as PublicAccessType) : undefined);
}

export interface BlobRow {
  name: string;
  /** Last path segment. */
  label: string;
  size: number;
  contentType?: string;
  lastModified?: string;
  tier?: string;
  blobType?: string;
}

export interface Level {
  folders: Array<{ prefix: string; label: string }>;
  blobs: BlobRow[];
  /** Pass back to get the next page. */
  continuation?: string;
}

/** One "folder" level: virtual folders (by "/") and the blobs directly in it — like Azure Storage Explorer. */
export async function listLevel(h: ServiceHandle, containerName: string, prefix: string, maxItems = 500, continuation?: string): Promise<Level> {
  const iter = container(h, containerName)
    .listBlobsByHierarchy("/", { prefix })
    .byPage({ maxPageSize: Math.min(5000, Math.max(1, maxItems)), ...(continuation ? { continuationToken: continuation } : {}) });
  const page = (await iter.next()).value;
  const folders = (page?.segment.blobPrefixes ?? []).map((p: { name: string }) => ({ prefix: p.name, label: p.name.slice(prefix.length).replace(/\/$/, "") }));
  const blobs: BlobRow[] = (page?.segment.blobItems ?? []).map((b: { name: string; properties: { contentLength?: number; contentType?: string; lastModified?: Date; accessTier?: string; blobType?: string } }) => ({
    name: b.name,
    label: b.name.slice(prefix.length),
    size: b.properties.contentLength ?? 0,
    ...(b.properties.contentType ? { contentType: b.properties.contentType } : {}),
    ...(b.properties.lastModified ? { lastModified: b.properties.lastModified.toISOString() } : {}),
    ...(b.properties.accessTier ? { tier: b.properties.accessTier } : {}),
    ...(b.properties.blobType ? { blobType: b.properties.blobType } : {}),
  }));
  return { folders, blobs, ...(page?.continuationToken ? { continuation: page.continuationToken } : {}) };
}

/** Blobs whose name starts with `prefix`, across all folders (for search and prefix deletes). */
export async function listFlat(h: ServiceHandle, containerName: string, prefix: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  for await (const b of container(h, containerName).listBlobsFlat({ prefix })) {
    out.push(b.name);
    if (out.length >= limit) break;
  }
  return out;
}

export interface BlobDetail {
  container: string;
  name: string;
  url: string;
  size: number;
  contentType: string;
  contentEncoding?: string;
  cacheControl?: string;
  contentMd5?: string;
  etag?: string;
  lastModified?: string;
  createdOn?: string;
  blobType?: string;
  tier?: string;
  leaseState?: string;
  metadata: Record<string, string>;
  /** Present when the content can be shown. */
  text?: string;
  /** Base64, for images. */
  base64?: string;
  truncated: boolean;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-www-form-urlencoded|sql|x-sh|csv)|.*\+(json|xml)$)/i;
const TEXT_EXT = /\.(txt|md|json|jsonc|xml|csv|tsv|log|yml|yaml|ini|conf|cfg|toml|html?|css|js|mjs|cjs|ts|tsx|jsx|sql|sh|ps1|py|cs|java|go|rs|env|properties|svg)$/i;
const MAX_PREVIEW = 5 * 1024 * 1024;

export async function blobDetail(h: ServiceHandle, containerName: string, name: string, withContent = true): Promise<BlobDetail> {
  const client = container(h, containerName).getBlobClient(name);
  const p = await client.getProperties();
  const contentType = p.contentType ?? "application/octet-stream";
  const detail: BlobDetail = {
    container: containerName,
    name,
    url: client.url.split("?")[0]!,
    size: p.contentLength ?? 0,
    contentType,
    ...(p.contentEncoding ? { contentEncoding: p.contentEncoding } : {}),
    ...(p.cacheControl ? { cacheControl: p.cacheControl } : {}),
    ...(p.contentMD5 ? { contentMd5: Buffer.from(p.contentMD5).toString("base64") } : {}),
    ...(p.etag ? { etag: p.etag } : {}),
    ...(p.lastModified ? { lastModified: p.lastModified.toISOString() } : {}),
    ...(p.createdOn ? { createdOn: p.createdOn.toISOString() } : {}),
    ...(p.blobType ? { blobType: p.blobType } : {}),
    ...(p.accessTier ? { tier: p.accessTier } : {}),
    ...(p.leaseState ? { leaseState: p.leaseState } : {}),
    metadata: p.metadata ?? {},
    truncated: false,
  };
  if (!withContent || detail.tier === "Archive") return detail;
  const isText = TEXT_TYPES.test(contentType) || TEXT_EXT.test(name);
  const isImage = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.test(contentType) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
  if (!isText && !isImage) return detail;
  const length = Math.min(detail.size, MAX_PREVIEW);
  const buf = detail.size === 0 ? Buffer.alloc(0) : await client.downloadToBuffer(0, length);
  detail.truncated = detail.size > MAX_PREVIEW;
  if (isText && !buf.subarray(0, 8000).includes(0)) detail.text = buf.toString("utf-8").replace(/^﻿/, "");
  else if (isImage && !detail.truncated) detail.base64 = buf.toString("base64");
  return detail;
}

const GUESS: Record<string, string> = {
  ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".html": "text/html", ".htm": "text/html",
  ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".zip": "application/zip", ".yaml": "application/x-yaml", ".yml": "application/x-yaml", ".log": "text/plain",
};
export const guessContentType = (name: string): string => GUESS[extname(name).toLowerCase()] ?? "application/octet-stream";

/** Saves edited text back, keeping the blob's content type and metadata. */
export async function writeText(h: ServiceHandle, containerName: string, name: string, text: string, etag?: string): Promise<void> {
  const client = container(h, containerName).getBlockBlobClient(name);
  const props = await client.getProperties();
  if (etag && props.etag && etag !== props.etag) throw new BlobPluginError("The blob changed since you opened it — reload it first (your edits would overwrite someone else's).");
  const body = Buffer.from(text, "utf-8");
  await client.upload(body, body.length, {
    blobHTTPHeaders: { blobContentType: props.contentType ?? guessContentType(name), ...(props.cacheControl ? { blobCacheControl: props.cacheControl } : {}) },
    metadata: props.metadata ?? {},
    ...(props.accessTier && props.accessTier !== "Archive" ? { tier: props.accessTier } : {}),
  });
}

const MAX_UPLOAD = 200 * 1024 * 1024;

export async function upload(h: ServiceHandle, containerName: string, name: string, base64: string, contentType: string | undefined, overwrite: boolean): Promise<void> {
  if (!name || name.endsWith("/")) throw new BlobPluginError("A blob needs a name.");
  const body = Buffer.from(base64, "base64");
  if (body.length > MAX_UPLOAD) throw new BlobPluginError("Files over 200 MB can't be uploaded from here yet.");
  const client = container(h, containerName).getBlockBlobClient(name);
  await client.uploadData(body, {
    blobHTTPHeaders: { blobContentType: contentType || guessContentType(name) },
    ...(overwrite ? {} : { conditions: { ifNoneMatch: "*" } }),
  });
}

/** Azure has no real folders: a folder exists while a blob is in it, so a new folder gets a small placeholder. */
export async function createFolder(h: ServiceHandle, containerName: string, prefix: string, name: string): Promise<string> {
  const clean = name.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) throw new BlobPluginError("Enter a folder name.");
  const blob = `${prefix}${clean}/.keep`;
  await container(h, containerName).getBlockBlobClient(blob).upload("", 0, { blobHTTPHeaders: { blobContentType: "application/octet-stream" } });
  return `${prefix}${clean}/`;
}

export async function deleteBlobs(h: ServiceHandle, containerName: string, names: string[]): Promise<number> {
  const c = container(h, containerName);
  let n = 0;
  for (const name of names) {
    await c.getBlobClient(name).deleteIfExists({ deleteSnapshots: "include" });
    n++;
  }
  return n;
}

export async function deletePrefix(h: ServiceHandle, containerName: string, prefix: string): Promise<number> {
  if (!prefix) throw new BlobPluginError("Refusing to delete with an empty prefix — delete the container instead.");
  return deleteBlobs(h, containerName, await listFlat(h, containerName, prefix, 100_000));
}

/** Copies within the account (server-side), then deletes the source: Azure has no rename. */
export async function moveBlob(h: ServiceHandle, containerName: string, from: string, to: string, keepSource = false): Promise<void> {
  if (!to || to === from) throw new BlobPluginError("Enter a different name.");
  const c = container(h, containerName);
  const target = c.getBlobClient(to);
  if (await target.exists()) throw new BlobPluginError(`"${to}" already exists.`);
  const source = c.getBlobClient(from);
  const sourceUrl = h.credential ? `${source.url}?${generateBlobSASQueryParameters({ containerName, blobName: from, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + 3600_000) }, h.credential).toString()}` : source.url;
  const poller = await target.beginCopyFromURL(sourceUrl);
  await poller.pollUntilDone();
  if (!keepSource) await source.delete({ deleteSnapshots: "include" });
}

export async function setMetadata(h: ServiceHandle, containerName: string, name: string, metadata: Record<string, string>): Promise<void> {
  for (const k of Object.keys(metadata)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new BlobPluginError(`"${k}" isn't a valid metadata name (letters, digits and _; not starting with a digit).`);
  await container(h, containerName).getBlobClient(name).setMetadata(metadata);
}

export async function setHeaders(h: ServiceHandle, containerName: string, name: string, headers: { contentType?: string; cacheControl?: string }): Promise<void> {
  const client = container(h, containerName).getBlobClient(name);
  const p = await client.getProperties();
  // setHTTPHeaders replaces all of them: carry over the ones we aren't changing.
  const keep = <K extends string, V>(key: K, value: V | undefined) => (value === undefined || value === "" ? {} : ({ [key]: value } as Record<K, V>));
  await client.setHTTPHeaders({
    ...keep("blobContentType", headers.contentType ?? p.contentType),
    ...keep("blobCacheControl", headers.cacheControl ?? p.cacheControl),
    ...keep("blobContentEncoding", p.contentEncoding),
    ...keep("blobContentLanguage", p.contentLanguage),
    ...keep("blobContentDisposition", p.contentDisposition),
    ...keep("blobContentMD5", p.contentMD5),
  });
}

export async function setTier(h: ServiceHandle, containerName: string, name: string, tier: string): Promise<void> {
  if (!["Hot", "Cool", "Cold", "Archive"].includes(tier)) throw new BlobPluginError(`Unknown tier "${tier}".`);
  await container(h, containerName).getBlobClient(name).setAccessTier(tier as "Hot");
}

/** A time-limited link to a blob (or a whole container). Needs account-key auth. */
export function sasUrl(h: ServiceHandle, containerName: string, name: string | undefined, permissions: string, hours: number): string {
  if (!h.credential) throw new BlobPluginError("Signing SAS links needs the account key — connect with a connection string or account name + key.");
  const expiresOn = new Date(Date.now() + Math.max(1, Math.min(24 * 365, hours)) * 3600_000);
  const startsOn = new Date(Date.now() - 5 * 60_000);
  const c = container(h, containerName);
  if (name) {
    const q = generateBlobSASQueryParameters({ containerName, blobName: name, permissions: BlobSASPermissions.parse(permissions || "r"), startsOn, expiresOn }, h.credential);
    return `${c.getBlobClient(name).url}?${q.toString()}`;
  }
  const q = generateBlobSASQueryParameters({ containerName, permissions: ContainerSASPermissions.parse(permissions || "rl"), startsOn, expiresOn }, h.credential);
  return `${c.url}?${q.toString()}`;
}

/** Downloads to the user's Downloads folder (never overwriting), returning the path. */
export async function download(h: ServiceHandle, containerName: string, name: string): Promise<string> {
  const dir = join(homedir(), "Downloads");
  mkdirSync(dir, { recursive: true });
  const base = basename(name) || "blob";
  const ext = extname(base);
  let target = join(dir, base);
  for (let n = 1; existsSync(target); n++) target = join(dir, `${base.slice(0, base.length - ext.length)} (${n})${ext}`);
  const buf = await container(h, containerName).getBlobClient(name).downloadToBuffer();
  await writeFile(target, buf);
  return target;
}
