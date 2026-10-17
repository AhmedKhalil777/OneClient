import { BlobPluginError, describeBlobError } from "./client.js";
import {
  blobDetail,
  createContainer,
  createFolder,
  deleteBlobs,
  deleteContainer,
  deletePrefix,
  download,
  listContainers,
  listLevel,
  moveBlob,
  sasUrl,
  setContainerAccess,
  setHeaders,
  setMetadata,
  setTier,
  upload,
  writeText,
} from "./blobs.js";
import { requireSession } from "./sessions.js";

type Params = Record<string, unknown>;
const str = (p: Params, key: string): string => {
  const v = p[key];
  if (typeof v !== "string") throw new BlobPluginError(`Missing "${key}".`);
  return v;
};
const opt = (p: Params, key: string): string | undefined => (typeof p[key] === "string" ? (p[key] as string) : undefined);
const names = (p: Params): string[] => (Array.isArray(p.names) ? p.names.filter((n): n is string => typeof n === "string") : []);

export type BlobLogger = (level: "info" | "warn" | "error", message: string, detail?: string) => void;
let log: BlobLogger = () => {};
export const setBlobLogger = (fn: BlobLogger): void => void (log = fn);

/** Everything the views do (`azblob.api`). Changes are logged to the Output panel. */
const API: Record<string, (cid: string, p: Params) => Promise<unknown>> = {
  account: async (cid) => {
    const h = requireSession(cid);
    return { accountName: h.accountName, canSign: Boolean(h.credential), onlyContainer: h.onlyContainer ?? null, url: h.service.url.split("?")[0] };
  },
  containers: async (cid) => listContainers(requireSession(cid)),
  createContainer: async (cid, p) => {
    await createContainer(requireSession(cid), str(p, "name").trim(), opt(p, "access") ?? "private");
    log("info", `created container ${str(p, "name")}`);
    return {};
  },
  deleteContainer: async (cid, p) => {
    await deleteContainer(requireSession(cid), str(p, "container"));
    log("warn", `deleted container ${str(p, "container")}`);
    return {};
  },
  setAccess: async (cid, p) => {
    await setContainerAccess(requireSession(cid), str(p, "container"), str(p, "access"));
    log("info", `${str(p, "container")}: public access → ${str(p, "access")}`);
    return {};
  },
  list: async (cid, p) => listLevel(requireSession(cid), str(p, "container"), opt(p, "prefix") ?? "", Number(p.max) || 500, opt(p, "continuation")),
  blob: async (cid, p) => blobDetail(requireSession(cid), str(p, "container"), str(p, "name"), p.content !== false),
  save: async (cid, p) => {
    await writeText(requireSession(cid), str(p, "container"), str(p, "name"), str(p, "text"), opt(p, "etag"));
    log("info", `saved ${str(p, "container")}/${str(p, "name")}`);
    return {};
  },
  upload: async (cid, p) => {
    await upload(requireSession(cid), str(p, "container"), str(p, "name"), str(p, "base64"), opt(p, "contentType"), p.overwrite === true);
    log("info", `uploaded ${str(p, "container")}/${str(p, "name")}`);
    return {};
  },
  createFolder: async (cid, p) => ({ prefix: await createFolder(requireSession(cid), str(p, "container"), opt(p, "prefix") ?? "", str(p, "name")) }),
  delete: async (cid, p) => {
    const n = await deleteBlobs(requireSession(cid), str(p, "container"), names(p));
    log("warn", `deleted ${n} blob(s) in ${str(p, "container")}`, names(p).join("\n"));
    return { deleted: n };
  },
  deletePrefix: async (cid, p) => {
    const n = await deletePrefix(requireSession(cid), str(p, "container"), str(p, "prefix"));
    log("warn", `deleted folder ${str(p, "container")}/${str(p, "prefix")} (${n} blob(s))`);
    return { deleted: n };
  },
  move: async (cid, p) => {
    await moveBlob(requireSession(cid), str(p, "container"), str(p, "from"), str(p, "to"), p.copy === true);
    log("info", `${p.copy === true ? "copied" : "moved"} ${str(p, "container")}/${str(p, "from")} → ${str(p, "to")}`);
    return {};
  },
  metadata: async (cid, p) => {
    await setMetadata(requireSession(cid), str(p, "container"), str(p, "name"), (p.metadata ?? {}) as Record<string, string>);
    return {};
  },
  headers: async (cid, p) => {
    await setHeaders(requireSession(cid), str(p, "container"), str(p, "name"), { ...(opt(p, "contentType") ? { contentType: opt(p, "contentType")! } : {}), ...(opt(p, "cacheControl") !== undefined ? { cacheControl: opt(p, "cacheControl")! } : {}) });
    return {};
  },
  tier: async (cid, p) => {
    await setTier(requireSession(cid), str(p, "container"), str(p, "name"), str(p, "tier"));
    log("info", `${str(p, "container")}/${str(p, "name")}: tier → ${str(p, "tier")}`);
    return {};
  },
  sas: async (cid, p) => ({ url: sasUrl(requireSession(cid), str(p, "container"), opt(p, "name"), opt(p, "permissions") ?? "r", Number(p.hours) || 1) }),
  download: async (cid, p) => ({ path: await download(requireSession(cid), str(p, "container"), str(p, "name")) }),
};

export type ApiResult = { ok: true; data: unknown } | { ok: false; error: string };

export async function callApi(connectionId: string | undefined, method: string, params: Params): Promise<ApiResult> {
  try {
    if (!connectionId) throw new BlobPluginError("No connection id provided.");
    const handler = API[method];
    if (!handler) throw new BlobPluginError(`Unknown operation "${method}".`);
    return { ok: true, data: await handler(connectionId, params) };
  } catch (err) {
    return { ok: false, error: err instanceof BlobPluginError ? err.message : describeBlobError(err) };
  }
}
