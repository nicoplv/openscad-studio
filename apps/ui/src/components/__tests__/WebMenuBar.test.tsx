/** @jest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { jest } from '@jest/globals';
import { eventBus } from '../../platform';
import { WebMenuBar } from '../WebMenuBar';

describe('WebMenuBar', () => {
  it('opens workspace panels from the Window menu', () => {
    const emit = jest.spyOn(eventBus, 'emit');

    render(
      <WebMenuBar
        onExport={() => {}}
        onSettings={() => {}}
        onUndo={() => {}}
        onRedo={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Window' }));
    expect(document.querySelectorAll('.web-menubar__separator')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));

    expect(emit).toHaveBeenCalledWith('menu:window:open_panel', 'files');

    fireEvent.click(screen.getByRole('button', { name: 'Window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset workspace' }));

    expect(emit).toHaveBeenCalledWith('menu:window:reset_workspace');
    emit.mockRestore();
  });
});
