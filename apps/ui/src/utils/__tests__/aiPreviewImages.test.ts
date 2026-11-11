import { jest } from '@jest/globals';
import { createOpenAI } from '@ai-sdk/openai';
import { stepCountIs, streamText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { prepareOpenAiCompatiblePreviewStep } from '../aiPreviewImages';

const screenshotTool = 'get_preview_screenshot';
const rawPng = (name: string) => `data:image/png;base64,${btoa(name)}`;
const captureError = 'No preview available.';
const jpeg = 'data:image/jpeg;base64,cmVzaXplZA==';
const png = 'data:image/png;base64,cmVzaXplZA==';

let width: number;
let height: number;
let alpha: number;
let previewKind: '2d' | '3d';
let decodeFails: boolean;
const decodedSources: string[] = [];
const drawImage = jest.fn();
const getImageData = jest.fn(() => ({ data: [0, 0, 0, alpha] }));
const toDataURL = jest.fn((type: string) => (type === 'image/jpeg' ? jpeg : png));

beforeEach(() => {
  width = 1600;
  height = 1000;
  alpha = 255;
  previewKind = '3d';
  decodeFails = false;
  decodedSources.length = 0;
  jest.clearAllMocks();

  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      naturalWidth = width;
      naturalHeight = height;
      onload?: () => void;
      onerror?: () => void;

      set src(value: string) {
        decodedSources.push(value);
        queueMicrotask(() => (decodeFails ? this.onerror?.() : this.onload?.()));
      }
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => ({ drawImage, getImageData }),
        toDataURL,
      }),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'Image');
  Reflect.deleteProperty(globalThis, 'document');
});

interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; image_url?: { url: string } }>;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string }>;
}

function createMockChat(replies: Array<Array<{ name: string; args: object }>>) {
  const requests: ChatMessage[][] = [];
  const model = createOpenAI({
    apiKey: 'mock',
    baseURL: 'http://mock.invalid/v1',
    fetch: async (_url, init) => {
      const calls = replies[requests.length] ?? [];
      requests.push(JSON.parse(init?.body as string).messages);
      const delta = calls.length
        ? {
            role: 'assistant',
            tool_calls: calls.map(({ name, args }, index) => ({
              index,
              id: `call_${requests.length}_${index}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            })),
          }
        : { role: 'assistant', content: 'Done.' };
      const chunk = {
        id: 'mock',
        object: 'chat.completion.chunk',
        model: 'mock',
        choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  }).chat('mock');
  return { model, requests };
}

async function runTurn(
  model: ReturnType<typeof createMockChat>['model'],
  messages: ModelMessage[]
) {
  const result = streamText({
    model,
    messages,
    tools: {
      get_preview_screenshot: tool({
        inputSchema: z.object({ view: z.string() }),
        execute: async ({ view }) =>
          view === 'missing'
            ? { error: captureError }
            : { image_data_url: rawPng(view), __previewKind: previewKind },
        toModelOutput: ({ output }) =>
          output.image_data_url
            ? {
                type: 'content',
                value: [
                  {
                    type: 'image-data',
                    data: output.image_data_url.split(',')[1],
                    mediaType: 'image/png',
                  },
                ],
              }
            : { type: 'text', value: output.error },
      }),
      read_file: tool({ inputSchema: z.object({}), execute: async () => 'cube(10);' }),
    },
    stopWhen: stepCountIs(5),
    prepareStep: prepareOpenAiCompatiblePreviewStep,
  });
  for await (const part of result.fullStream) {
    if (part.type === 'error') throw part.error;
  }
  return (await result.response).messages;
}

function imageUrls(messages: ChatMessage[]) {
  return messages.flatMap(({ content }) =>
    Array.isArray(content)
      ? content.filter((part) => part.type === 'image_url').map((part) => part.image_url?.url)
      : []
  );
}

const firstMessage: ModelMessage = { role: 'user', content: 'Look at the preview.' };

it('sends only the newest screenshot once and keeps tool replies paired across steps and turns', async () => {
  const { model, requests } = createMockChat([
    [
      { name: screenshotTool, args: { view: 'front' } },
      { name: screenshotTool, args: { view: 'top' } },
      { name: screenshotTool, args: { view: 'missing' } },
    ],
    [{ name: 'read_file', args: {} }],
  ]);
  const history = await runTurn(model, [firstMessage]);
  await runTurn(model, [firstMessage, ...history, { role: 'user', content: 'Add a heart.' }]);

  expect(requests.map(imageUrls)).toEqual([[], [jpeg], [], []]);
  expect(decodedSources).toEqual([rawPng('top')]);
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 500);
  expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.82);
  expect(requests[1].slice(-2)).toEqual([
    expect.objectContaining({ role: 'tool', content: captureError, tool_call_id: 'call_1_2' }),
    expect.objectContaining({ role: 'user' }),
  ]);
  for (const messages of requests.slice(1)) {
    const calls = messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []);
    const results = messages.filter(({ role }) => role === 'tool');
    expect(results.map(({ tool_call_id }) => tool_call_id)).toEqual(calls);
    expect(results.map(({ content }) => content)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/image-data|base64/)])
    );
  }
  expect(requests[3].filter(({ role }) => role === 'tool').map(({ content }) => content)).toContain(
    'cube(10);'
  );
});

it.each([
  { kind: '2d' as const, alphaValue: 255, size: [320, 240], expected: [320, 240] },
  { kind: '3d' as const, alphaValue: 0, size: [500, 1000], expected: [400, 800] },
])(
  'uses PNG for a $kind preview with alpha $alphaValue',
  async ({ kind, alphaValue, size, expected }) => {
    previewKind = kind;
    alpha = alphaValue;
    [width, height] = size;
    const { model, requests } = createMockChat([[{ name: screenshotTool, args: { view: 'top' } }]]);

    await runTurn(model, [firstMessage]);

    expect(imageUrls(requests[1])).toEqual([png]);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, ...expected);
    expect(toDataURL).toHaveBeenCalledWith('image/png');
  }
);

it('keeps a short tool error and omits image data if preparation fails', async () => {
  decodeFails = true;
  const { model, requests } = createMockChat([[{ name: screenshotTool, args: { view: 'top' } }]]);

  await runTurn(model, [firstMessage]);

  expect(imageUrls(requests[1])).toEqual([]);
  expect(requests[1][requests[1].length - 1]).toEqual(
    expect.objectContaining({
      role: 'tool',
      tool_call_id: 'call_1_0',
      content: 'Could not prepare the preview image.',
    })
  );
});
