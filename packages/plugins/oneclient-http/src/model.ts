/** Data model of an HTTP workspace — the shape stored on disk and exchanged with the views. */

export interface KV {
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}

export interface FormField extends KV {
  /** "file" fields hold a path on this machine in `value`. */
  type: "text" | "file";
}

export type AuthDef =
  /** Use the nearest folder / collection setting. */
  | { type: "inherit" }
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "apikey"; key: string; value: string; in: "header" | "query" };

export type RawLanguage = "json" | "text" | "xml" | "html" | "javascript";

export type BodyDef =
  | { mode: "none" }
  | { mode: "raw"; raw: string; language: RawLanguage }
  | { mode: "urlencoded"; fields: KV[] }
  | { mode: "formdata"; fields: FormField[] };

export interface RequestDef {
  method: string;
  /** May contain `{{variables}}`. Query parameters are part of the URL. */
  url: string;
  headers: KV[];
  body: BodyDef;
  auth: AuthDef;
}

export interface RequestItem {
  type: "request";
  id: string;
  name: string;
  description?: string;
  request: RequestDef;
}

export interface FolderItem {
  type: "folder";
  id: string;
  name: string;
  description?: string;
  auth?: AuthDef;
  items: Item[];
}

export type Item = RequestItem | FolderItem;

export interface Collection {
  id: string;
  name: string;
  description?: string;
  auth: AuthDef;
  /** Collection variables — lower priority than the active environment. */
  variables: KV[];
  items: Item[];
}

export interface Environment {
  id: string;
  name: string;
  variables: Array<KV & { secret?: boolean }>;
}

export interface HistoryEntry {
  id: string;
  /** Epoch ms. */
  time: number;
  method: string;
  /** The URL as sent (variables resolved). */
  url: string;
  status?: number;
  ms?: number;
  error?: string;
  /** The request as written (variables unresolved), so it can be reopened. */
  request: RequestDef;
}

/** Bump `WORKSPACE_VERSION` and add a step to `migrateWorkspace` (store.ts) when this shape changes. */
export const WORKSPACE_VERSION = 1;

export interface Workspace {
  version: number;
  collections: Collection[];
  environments: Environment[];
  activeEnvironmentId?: string | undefined;
  history: HistoryEntry[];
}

export const emptyRequest = (): RequestDef => ({ method: "GET", url: "", headers: [], body: { mode: "none" }, auth: { type: "inherit" } });

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
