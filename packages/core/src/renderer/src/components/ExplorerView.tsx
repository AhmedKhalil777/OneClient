import { useState } from "react";
import type { TreeNode } from "@oneclient/plugin-api";
import type { WorkspaceFolderInfo } from "../../../shared/ipc-contract.js";
import { ThemeIcon } from "../theme.js";
import { ExplorerTreeNode } from "./ExplorerTree.js";
import { SidebarSection } from "./Sidebar.js";

/** Context values of the Explorer's nodes (plugins' `when` clauses can target them, e.g. "Open in Terminal"). */
export const FOLDER_NODE = "files.directory";
export const FILE_NODE = "files.file";

/** The tree root for an open folder: a directory node at the folder itself. */
export function folderRoot(folder: WorkspaceFolderInfo, expanded: boolean): TreeNode {
  return {
    id: `folder:${folder.id}`,
    label: folder.name,
    nodeType: FOLDER_NODE,
    contextValue: FOLDER_NODE,
    collapsible: expanded ? "expanded" : "collapsed",
    icon: "$(folder)",
    resource: { name: folder.name, kind: "folder" },
    data: { path: "", fsPath: folder.path, root: true },
  };
}

/**
 * The Explorer (core): the folders open in the workspace, each a lazily expanded file tree. Clicking a file opens it
 * in the editor; right-click for New File / Folder, Rename, Delete, Open in Terminal, Copy Path… — and whatever
 * plugins add for files and folders.
 */
export function ExplorerView({
  folders,
  tokens,
  onOpenFolder,
  onNewFile,
  onNewFolder,
  onOpenNode,
  onContextMenu,
}: {
  folders: WorkspaceFolderInfo[];
  /** Bumped per folder to re-list its tree (after a file was created, renamed…). */
  tokens: Record<string, number>;
  onOpenFolder: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onOpenNode: (folder: WorkspaceFolderInfo, node: TreeNode) => void;
  onContextMenu: (e: React.MouseEvent, folder: WorkspaceFolderInfo, node: TreeNode, refresh: () => void) => void;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [collapseKey, setCollapseKey] = useState(0);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>EXPLORER</span>
      </div>
      <SidebarSection
        containerId="explorer"
        sectionId="folders"
        title="Folders"
        count={folders.length}
        actions={
          <>
            <button className="icon-button" title="New File… (Ctrl+N)" disabled={!folders.length} onClick={onNewFile}>
              <ThemeIcon id="file" />
            </button>
            <button className="icon-button" title="New Folder…" disabled={!folders.length} onClick={onNewFolder}>
              <ThemeIcon id="folder" />
            </button>
            <button className="icon-button" title="Open Folder… (Ctrl+O)" onClick={onOpenFolder}>
              <ThemeIcon id="add" />
            </button>
            <button className="icon-button" title="Refresh" onClick={() => setRefreshKey((k) => k + 1)}>
              <ThemeIcon id="refresh" />
            </button>
            <button className="icon-button" title="Collapse Folders" disabled={!folders.length} onClick={() => setCollapseKey((k) => k + 1)}>
              <ThemeIcon id="collapse-all" />
            </button>
          </>
        }
      >
        {folders.length === 0 ? (
          <div className="empty-hint explorer-empty">
            <p>You have not opened a folder yet.</p>
            <button className="btn btn-primary" onClick={onOpenFolder}>
              Open Folder
            </button>
          </div>
        ) : (
          folders.map((f) => (
            <ExplorerTreeNode
              key={`${f.id}:${refreshKey}:${collapseKey}`}
              refreshToken={tokens[f.id] ?? 0}
              connectionId={f.id}
              pluginId="core"
              node={folderRoot(f, folders.length === 1 && collapseKey === 0)}
              depth={0}
              onOpenView={(node) => onOpenNode(f, node)}
              onContextMenu={(e, node, refresh) => onContextMenu(e, f, node, refresh)}
              reloadParent={() => setRefreshKey((k) => k + 1)}
            />
          ))
        )}
      </SidebarSection>
    </div>
  );
}
