/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { FileTreePanel } from '../FileTree';

describe('FileTreePanel', () => {
  it('uses the dock tab header instead of custom collapse and create controls', () => {
    render(
      <FileTreePanel
        onFileDoubleClick={() => {}}
        onRenameFile={() => {}}
        onDeleteFile={() => {}}
        onDeleteFolder={() => {}}
        onSetRenderTarget={() => {}}
        onCreateFile={async () => 'new_file.scad'}
        onCreateFolder={async () => {}}
        onMoveItem={() => {}}
        onAddExternalFiles={() => {}}
      />
    );

    expect(screen.getByTestId('file-tree-root')).toBeTruthy();
    expect(screen.queryByTitle('New file')).toBeNull();
    expect(screen.queryByTitle('Hide file tree')).toBeNull();
    expect(screen.queryByTitle('Show file tree')).toBeNull();
  });
});
