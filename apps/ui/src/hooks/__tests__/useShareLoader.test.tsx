/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react';
import { jest } from '@jest/globals';

const mockGetShare = jest.fn();

jest.unstable_mockModule('@/services/shareService', () => ({
  getShare: (...args: unknown[]) => mockGetShare(...args),
}));

let useShareLoader: typeof import('../useShareLoader').useShareLoader;

function TestComponent({ enabled = true }: { enabled?: boolean }) {
  const state = useShareLoader(enabled);

  return (
    <div>
      <div data-testid="loading">{String(state.isLoading)}</div>
      <div data-testid="error">{state.error ?? ''}</div>
      <div data-testid="title">{state.shareData?.title ?? ''}</div>
      <div data-testid="share-id">{state.shareContext?.shareId ?? ''}</div>
    </div>
  );
}

describe('useShareLoader', () => {
  beforeAll(async () => {
    ({ useShareLoader } = await import('../useShareLoader'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, '', '/');
    delete window.__SHARE_CONTEXT;
  });

  it('loads share data and cleans the URL after success', async () => {
    mockGetShare.mockResolvedValue({
      id: 'abc12345',
      code: 'cube(10);',
      title: 'Test Share',
      createdAt: '2026-03-24T00:00:00.000Z',
      forkedFrom: null,
      thumbnailUrl: null,
    });

    window.__SHARE_CONTEXT = { shareId: 'abc12345' };
    window.history.replaceState({}, '', '/s/abc12345');

    render(<TestComponent />);

    expect(screen.getByTestId('share-id').textContent).toBe('abc12345');
    await waitFor(() => {
      expect(screen.getByTestId('title').textContent).toBe('Test Share');
    });
    expect(window.location.pathname).toBe('/');
  });

  it('shows a friendly not-found error', async () => {
    const error = new Error('Design not found') as Error & { status: number };
    error.status = 404;
    mockGetShare.mockRejectedValue(error);

    window.__SHARE_CONTEXT = { shareId: 'missing' };

    render(<TestComponent />);

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe(
        "This design doesn't exist or has been removed."
      );
    });
  });

  it('stays idle when disabled', () => {
    window.__SHARE_CONTEXT = { shareId: 'abc12345' };

    render(<TestComponent enabled={false} />);

    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(mockGetShare).not.toHaveBeenCalled();
  });
});
