/** @jest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { jest } from '@jest/globals';
import type { IDockviewPanelHeaderProps } from 'dockview';
import type { ReactNode } from 'react';

jest.unstable_mockModule('@/contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ previewKind: 'stl' }),
}));
jest.unstable_mockModule('@/components/Editor', () => ({ Editor: () => null }));
jest.unstable_mockModule('@/components/Preview', () => ({ Preview: () => null }));
jest.unstable_mockModule('@/components/AiPromptPanel', () => ({ AiPromptPanel: () => null }));
jest.unstable_mockModule('@/components/DiagnosticsPanel', () => ({
  DiagnosticsPanel: () => null,
}));
jest.unstable_mockModule('@/components/DiffViewer', () => ({ DiffViewer: () => null }));
jest.unstable_mockModule('@/components/CustomizerPanel', () => ({ CustomizerPanel: () => null }));
jest.unstable_mockModule('@/components/FileTree', () => ({ FileTreePanel: () => null }));
jest.unstable_mockModule('@/components/ErrorBoundary', () => ({
  PanelErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));

const { WorkspaceTab } = await import('../panels/PanelComponents');

describe('WorkspaceTab', () => {
  it('closes its dock panel from the tab header', () => {
    const close = jest.fn();
    const props = {
      api: {
        id: 'files',
        title: 'Files',
        close,
        group: { api: { id: 'group-1' } },
      },
      containerApi: {},
    } as unknown as IDockviewPanelHeaderProps;

    render(<WorkspaceTab {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Files' }));

    expect(close).toHaveBeenCalledTimes(1);
  });
});
