import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Root folder (absolute path) per live connectionId. Module-level is fine:
 * each plugin runs in its own extension-host process.
 */
export const roots = new Map<string, string>();

export function requireRoot(connectionId: string | undefined): string {
  if (!connectionId) throw new Error("No connection id provided.");
  const root = roots.get(connectionId);
  if (!root) throw new Error("Folder is not open — expand it in the Files explorer first.");
  return root;
}

/**
 * Resolves a root-relative path (always "/"-separated, as stored on tree
 * nodes) to an absolute path, refusing anything that escapes the root —
 * the editor view is sandboxed, but it still shouldn't be able to ask for
 * `../../etc/passwd`.
 */
export function resolveInRoot(root: string, relPath: string): string {
  const absolute = resolve(root, ...relPath.split("/").filter(Boolean));
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path "${relPath}" is outside the open folder.`);
  }
  return absolute;
}

export function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}
