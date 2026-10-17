import { AnonymousCredential, BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";

export const AUTH_CONNECTION_STRING = "Connection string";
export const AUTH_ACCOUNT_KEY = "Account name and key";
export const AUTH_SAS = "SAS URL";
export const AUTH_AZURITE = "Local emulator (Azurite)";

export interface BlobConnectionConfig {
  authentication?: string;
  connectionString?: string;
  accountName?: string;
  accountKey?: string;
  /** Blob endpoint, e.g. https://myaccount.blob.core.windows.net (defaults from the account name). */
  endpoint?: string;
  /** Account or container SAS URL. */
  sasUrl?: string;
}

export class BlobPluginError extends Error {}

export interface ServiceHandle {
  service: BlobServiceClient;
  /** Present with account-key auth: needed to sign SAS links. */
  credential?: StorageSharedKeyCredential;
  accountName: string;
  /** A container SAS only grants that container. */
  onlyContainer?: string;
}

/** Pulls AccountName / AccountKey out of a connection string (for SAS signing). */
function parseConnectionString(cs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cs.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Azurite's well-known development account. */
const DEV_ACCOUNT = "devstoreaccount1";
const DEV_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

export function buildService(cfg: BlobConnectionConfig): ServiceHandle {
  const auth = cfg.authentication ?? AUTH_CONNECTION_STRING;
  try {
    if (auth === AUTH_AZURITE) {
      const endpoint = cfg.endpoint?.trim() || `http://127.0.0.1:10000/${DEV_ACCOUNT}`;
      const credential = new StorageSharedKeyCredential(DEV_ACCOUNT, DEV_KEY);
      return { service: new BlobServiceClient(endpoint, credential), credential, accountName: DEV_ACCOUNT };
    }
    if (auth === AUTH_ACCOUNT_KEY) {
      const name = cfg.accountName?.trim();
      if (!name || !cfg.accountKey) throw new BlobPluginError("Enter the storage account name and one of its access keys.");
      const credential = new StorageSharedKeyCredential(name, cfg.accountKey.trim());
      const endpoint = cfg.endpoint?.trim() || `https://${name}.blob.core.windows.net`;
      return { service: new BlobServiceClient(endpoint, credential), credential, accountName: name };
    }
    if (auth === AUTH_SAS) {
      const url = cfg.sasUrl?.trim();
      if (!url || !url.includes("?")) throw new BlobPluginError("Paste a SAS URL (it contains a ?sv=… query string).");
      const u = new URL(url);
      const segments = u.pathname.split("/").filter(Boolean);
      // Path-style hosts (Azurite, IP addresses: http://127.0.0.1:10000/account/container) carry the account in the path.
      const pathStyle = /^(\d+\.\d+\.\d+\.\d+|localhost|\[.*\])$/.test(u.hostname);
      const accountName = pathStyle ? (segments[0] ?? "") : (u.hostname.split(".")[0] ?? "");
      const containerName = pathStyle ? segments[1] : segments[0];
      // A container SAS (…/container?sv=…) only works for that container.
      if (containerName) {
        const serviceUrl = `${u.protocol}//${u.host}${pathStyle ? `/${accountName}` : ""}${u.search}`;
        return { service: new BlobServiceClient(serviceUrl, new AnonymousCredential()), accountName, onlyContainer: containerName };
      }
      return { service: new BlobServiceClient(url, new AnonymousCredential()), accountName };
    }
    const cs = cfg.connectionString?.trim();
    if (!cs) throw new BlobPluginError("Paste the storage account's connection string (Azure portal → Access keys).");
    const service = BlobServiceClient.fromConnectionString(cs);
    const parts = parseConnectionString(cs);
    const dev = /usedevelopmentstorage=true/i.test(cs);
    const accountName = dev ? DEV_ACCOUNT : (parts.accountname ?? service.accountName);
    const key = dev ? DEV_KEY : parts.accountkey;
    return { service, accountName, ...(key ? { credential: new StorageSharedKeyCredential(accountName, key) } : {}) };
  } catch (err) {
    if (err instanceof BlobPluginError) throw err;
    throw new BlobPluginError(`The connection settings are invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Friendlier messages for the usual Storage errors. */
export function describeBlobError(err: unknown): string {
  const e = err as { statusCode?: number; code?: string; message?: string; details?: { errorCode?: string } };
  const code = e?.details?.errorCode ?? e?.code ?? "";
  const msg = (e?.message ?? String(err)).split("\n")[0]!;
  if (e?.code === "ECONNREFUSED") return "Connection refused — is the storage endpoint (or Azurite) running?";
  if (e?.code === "ENOTFOUND") return "Can't find the storage account host — check the account name / endpoint.";
  if (code === "AuthenticationFailed" || e?.statusCode === 403) return `Access denied (${code || "403"}) — check the key / SAS, its permissions and expiry.`;
  if (code === "ContainerNotFound") return "That container doesn't exist (any more).";
  if (code === "BlobNotFound") return "That blob doesn't exist (any more).";
  if (code === "ContainerAlreadyExists") return "A container with that name already exists.";
  if (code === "BlobAlreadyExists") return "A blob with that name already exists.";
  if (code === "InvalidResourceName" || code === "OutOfRangeInput") return "Invalid name — container names are 3–63 lower-case letters, numbers and dashes.";
  if (code === "PublicAccessNotPermitted") return "Public access is disabled on this storage account.";
  return code ? `${code}: ${msg}` : msg;
}
