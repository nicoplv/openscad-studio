import { useState, useCallback } from 'react';
import { FileTree } from './FileTree';

interface FileTreePanelProps {
  onFileDoubleClick: (path: string) => void;
  onRenameFile: (oldPath: string, newName: string) => void;
  onDeleteFile: (path: string) => void;
  onDeleteFolder: (path: string) => void;
  onSetRenderTarget: (path: string) => void;
  onCreateFile: (parentDir: string) => Promise<string>;
  onCreateFolder: (parentDir: string, folderName: string) => Promise<void>;
  onMoveItem: (sourcePath: string, destFolderPath: string, isFolder: boolean) => void;
  onAddExternalFiles: (files: Record<string, string>, targetFolderPath: string) => void;
}

export function FileTreePanel({
  onFileDoubleClick,
  onRenameFile,
  onDeleteFile,
  onDeleteFolder,
  onSetRenderTarget,
  onCreateFile,
  onCreateFolder,
  onMoveItem,
  onAddExternalFiles,
}: FileTreePanelProps) {
  const [pendingRenameFile, setPendingRenameFile] = useState<string | null>(null);

  // Track which folders the user has explicitly expanded. All folders start
  // collapsed so large directory trees don't overwhelm the sidebar.
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  /** Expand a folder and all its ancestor folders. */
  const expandPathAncestors = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        next.add(parts.slice(0, i).join('/'));
      }
      return next;
    });
  }, []);

  const handleCreateFile = useCallback(
    async (parentDir: string) => {
      const newPath = await onCreateFile(parentDir);
      if (parentDir) expandPathAncestors(newPath);
      setPendingRenameFile(newPath);
    },
    [onCreateFile, expandPathAncestors]
  );

  const handleCreateFolder = useCallback(
    async (parentDir: string, folderName: string) => {
      await onCreateFolder(parentDir, folderName);
      if (parentDir) expandPathAncestors(parentDir + '/' + folderName);
    },
    [onCreateFolder, expandPathAncestors]
  );

  return (
    <div
      className="h-full w-full overflow-y-auto overflow-x-hidden"
      style={{ backgroundColor: 'var(--bg-secondary)' }}
    >
      <FileTree
        pendingRenameFile={pendingRenameFile}
        expandedFolders={expandedFolders}
        toggleFolder={toggleFolder}
        onFileDoubleClick={onFileDoubleClick}
        onRenameFile={onRenameFile}
        onDeleteFile={onDeleteFile}
        onDeleteFolder={onDeleteFolder}
        onSetRenderTarget={onSetRenderTarget}
        onCreateFile={handleCreateFile}
        onCreateFolder={handleCreateFolder}
        onClearPendingRename={() => setPendingRenameFile(null)}
        onMoveItem={onMoveItem}
        onAddExternalFiles={onAddExternalFiles}
      />
    </div>
  );
}
