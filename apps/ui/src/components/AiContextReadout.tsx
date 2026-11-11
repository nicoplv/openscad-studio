import { useEffect, useState } from 'react';
import { getOpenAiCompatibleConfig } from '../stores/apiKeyStore';
import type { AiContextUsage } from '../types/aiChat';

export function AiContextReadout({
  modelId,
  usage,
}: {
  modelId: string;
  usage: AiContextUsage | null;
}) {
  const { baseUrl, apiKey } = getOpenAiCompatibleConfig();
  const [serverLimit, setServerLimit] = useState<number | null>(null);

  useEffect(() => {
    setServerLimit(null);
    if (!modelId) return;

    const controller = new AbortController();
    const loadLimit = async () => {
      try {
        const url = new URL(baseUrl);
        url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}/props`;
        url.search = '';
        url.searchParams.set('model', modelId);
        const response = await fetch(url.toString(), {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) return;
        const props = (await response.json()) as {
          default_generation_settings?: { n_ctx?: number };
        };
        const limit = props?.default_generation_settings?.n_ctx;
        if (limit && Number.isSafeInteger(limit) && limit > 0 && !controller.signal.aborted) {
          setServerLimit(limit);
        }
      } catch {
        // OpenAI-compatible servers are not required to expose model properties.
      }
    };
    void loadLimit();
    return () => controller.abort();
  }, [baseUrl, apiKey, modelId]);

  const limit = usage?.contextLimit ?? serverLimit;
  const input = usage?.inputTokens;
  if (limit === null && input === undefined) return null;

  const inputLabel = input?.toLocaleString();
  const limitLabel = limit?.toLocaleString();
  const title = [
    inputLabel && `Last request: ${inputLabel} input tokens.`,
    limitLabel && `Server context limit: ${limitLabel} tokens.`,
  ]
    .filter(Boolean)
    .join(' ');
  const overLimit = input !== undefined && limit !== null && input > limit;

  return (
    <span
      className="flex shrink-0 flex-col whitespace-nowrap text-[11px] leading-tight tabular-nums"
      title={title}
      style={{ color: overLimit ? 'var(--color-error)' : 'var(--text-secondary)' }}
    >
      <span>Context</span>
      <span>
        {inputLabel && limitLabel
          ? `${inputLabel} / ${limitLabel}`
          : inputLabel
            ? `${inputLabel} input`
            : `${limitLabel} limit`}
      </span>
    </span>
  );
}
