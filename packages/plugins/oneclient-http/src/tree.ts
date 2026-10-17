import { randomUUID } from "node:crypto";
import type { AuthDef, Collection, FolderItem, Item, KV, RequestDef, RequestItem, Workspace } from "./model.js";

export const newId = (): string => randomUUID();

export interface Located {
  collection: Collection;
  /** The array that contains the item (or the collection's own `items`). */
  siblings: Item[];
  index: number;
  item: Item;
  /** Folders from the collection down to (excluding) the item. */
  ancestors: FolderItem[];
}

function walk(items: Item[], ancestors: FolderItem[], id: string): { siblings: Item[]; index: number; item: Item; ancestors: FolderItem[] } | undefined {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.id === id) return { siblings: items, index: i, item, ancestors };
    if (item.type === "folder") {
      const found = walk(item.items, [...ancestors, item], id);
      if (found) return found;
    }
  }
  return undefined;
}

export function locate(ws: Workspace, id: string): Located | undefined {
  for (const collection of ws.collections) {
    const found = walk(collection.items, [], id);
    if (found) return { collection, ...found };
  }
  return undefined;
}

export const findCollection = (ws: Workspace, id: string): Collection | undefined => ws.collections.find((c) => c.id === id);

/** The items array a new child of `parentId` goes into — a collection's or a folder's. */
function childrenOf(ws: Workspace, parentId: string): Item[] | undefined {
  const col = findCollection(ws, parentId);
  if (col) return col.items;
  const loc = locate(ws, parentId);
  return loc?.item.type === "folder" ? loc.item.items : undefined;
}

export function addCollection(ws: Workspace, name: string): Collection {
  const c: Collection = { id: newId(), name, auth: { type: "none" }, variables: [], items: [] };
  ws.collections.push(c);
  return c;
}

export function addFolder(ws: Workspace, parentId: string, name: string): FolderItem {
  const children = childrenOf(ws, parentId);
  if (!children) throw new Error("The parent folder or collection no longer exists.");
  const f: FolderItem = { type: "folder", id: newId(), name, items: [] };
  children.push(f);
  return f;
}

export function addRequest(ws: Workspace, parentId: string, name: string, request: RequestDef): RequestItem {
  const children = childrenOf(ws, parentId);
  if (!children) throw new Error("The parent folder or collection no longer exists.");
  const r: RequestItem = { type: "request", id: newId(), name, request };
  children.push(r);
  return r;
}

export function rename(ws: Workspace, id: string, name: string): void {
  const col = findCollection(ws, id);
  if (col) {
    col.name = name;
    return;
  }
  const loc = locate(ws, id);
  if (!loc) throw new Error("That item no longer exists.");
  loc.item.name = name;
}

export function remove(ws: Workspace, id: string): void {
  const ci = ws.collections.findIndex((c) => c.id === id);
  if (ci >= 0) {
    ws.collections.splice(ci, 1);
    return;
  }
  const loc = locate(ws, id);
  if (!loc) throw new Error("That item no longer exists.");
  loc.siblings.splice(loc.index, 1);
}

/** Deep copy with fresh ids. */
function reId<T extends Item | Collection>(node: T): T {
  const copy = JSON.parse(JSON.stringify(node)) as T;
  const visit = (n: { id: string; items?: Item[] }) => {
    n.id = newId();
    n.items?.forEach(visit);
  };
  visit(copy as { id: string; items?: Item[] });
  return copy;
}

export function duplicate(ws: Workspace, id: string): string {
  const ci = ws.collections.findIndex((c) => c.id === id);
  if (ci >= 0) {
    const copy = reId(ws.collections[ci]!);
    copy.name = `${copy.name} copy`;
    ws.collections.splice(ci + 1, 0, copy);
    return copy.id;
  }
  const loc = locate(ws, id);
  if (!loc) throw new Error("That item no longer exists.");
  const copy = reId(loc.item);
  copy.name = `${copy.name} copy`;
  loc.siblings.splice(loc.index + 1, 0, copy);
  return copy.id;
}

/** What "inherit" means for the item at `loc`: the nearest folder's auth, else the collection's. */
export function inheritedAuth(loc: Located): AuthDef {
  for (let i = loc.ancestors.length - 1; i >= 0; i--) {
    const a = loc.ancestors[i]!.auth;
    if (a && a.type !== "inherit") return a;
  }
  return loc.collection.auth.type === "inherit" ? { type: "none" } : loc.collection.auth;
}

/** The auth that applies to a request: its own, or the inherited one. */
export function effectiveAuth(loc: Located, own: AuthDef | undefined = loc.item.type === "request" ? loc.item.request.auth : undefined): AuthDef {
  if (!own) return { type: "none" };
  return own.type === "inherit" ? inheritedAuth(loc) : own;
}

export function countRequests(items: Item[]): number {
  return items.reduce((n, i) => n + (i.type === "request" ? 1 : countRequests(i.items)), 0);
}

/** Path of names from the collection to the item ("Users / Get user"). */
export function pathOf(loc: Located): string[] {
  return [loc.collection.name, ...loc.ancestors.map((a) => a.name), loc.item.name];
}

export const kv = (key: string, value: string, enabled = true): KV => ({ key, value, enabled });
