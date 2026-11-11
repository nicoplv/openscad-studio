/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { jest } from '@jest/globals';
import { AiContextReadout } from '../AiContextReadout';
import { storeOpenAiCompatibleConfig } from '../../stores/apiKeyStore';

const fetchMock = jest.fn<typeof fetch>();
const originalFetch = globalThis.fetch;
const modelId = 'test/vision-model';

beforeEach(() => {
  localStorage.clear();
  storeOpenAiCompatibleConfig({
    baseUrl: 'https://example.test/gateway/v1',
    modelId,
    apiKey: 'test-key',
  });
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

it('shows the active server limit beside the last request size when both are available', async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ default_generation_settings: { n_ctx: 110080 } }),
  } as Response);
  const { rerender } = render(<AiContextReadout modelId={modelId} usage={null} />);

  expect(await screen.findByText('110,080 limit')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    'https://example.test/gateway/props?model=test%2Fvision-model',
    expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } })
  );

  rerender(<AiContextReadout modelId={modelId} usage={{ inputTokens: 8240 }} />);
  expect(screen.getByText('8,240 / 110,080')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('uses the reported input size and overflow limit when model properties are unavailable', () => {
  fetchMock.mockResolvedValue({ ok: false } as Response);
  const { rerender } = render(<AiContextReadout modelId={modelId} usage={{ inputTokens: 8240 }} />);
  expect(screen.getByText('8,240 input')).toBeInTheDocument();

  rerender(
    <AiContextReadout modelId={modelId} usage={{ inputTokens: 114753, contextLimit: 110080 }} />
  );
  expect(screen.getByText('114,753 / 110,080')).toBeInTheDocument();
});
