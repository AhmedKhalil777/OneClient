import type { Disposable } from "./context.js";

/**
 * The workspace: the folders the user has open in core's Explorer. It belongs to core, not to a plugin, so every
 * plugin can build on it — e.g. look for `*.sql` or `*.http` files, keep generated files next to the user's code,
 * or open a file in the shared editor (with all the editor features other plugins contribute) instead of writing
 * their own.
 */
export interface WorkspaceFolder {
  /** Shown in the Explorer. */
  readonly name: string;
  /** Absolute path on this machine. */
  readonly path: string;
}

export interface OpenFileOptions {
  /** 1-based line to reveal (and select). */
  readonly line?: number;
  /** 1-based column on that line. */
  readonly column?: number;
  /** Characters to select from the column. */
  readonly length?: number;
}

export interface Workspace {
  /** The open folders, in Explorer order. */
  getFolders(): Promise<WorkspaceFolder[]>;
  /** Fires when folders are opened or closed. */
  onDidChangeFolders(listener: (folders: WorkspaceFolder[]) => void): Disposable;
  /**
   * Opens a file in core's editor tab (or focuses it). The file must be inside an open folder — the promise
   * rejects otherwise.
   */
  openFile(path: string, options?: OpenFileOptions): Promise<void>;
}
