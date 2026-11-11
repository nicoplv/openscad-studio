import { z } from 'zod';

import { isRenderableOpenScadFilePath } from '../../../../packages/shared/src/openscadProjectFiles';

const hasFile = (files: Record<string, string>, path: string) =>
  Object.prototype.hasOwnProperty.call(files, path);

export const isValidProjectPath = (path: string) =>
  !/[\\:]/.test(path) &&
  !path.includes(String.fromCharCode(0)) &&
  path !== '.openscad-studio.json' &&
  path
    .split('/')
    .every((part) => part && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(part));
const relativePath = z.string().refine(isValidProjectPath);
const comment = z.object({
  id: z.string(),
  text: z.string(),
  position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  viewerKind: z.enum(['2d', '3d']),
  measurementUnit: z.enum(['mm', 'cm', 'in', 'units']),
  renderTargetPath: relativePath,
  sourceHash: z.string().optional(),
});
const messageBase = z.object({ id: z.string(), timestamp: z.number() });
const message = z.discriminatedUnion('type', [
  messageBase.extend({
    type: z.literal('user'),
    parts: z.array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('text'), text: z.string() }),
        z.object({ type: z.literal('comment'), comment }),
        z.object({
          type: z.literal('image'),
          attachmentId: z.string(),
          filename: z.string(),
          mimeType: z.string(),
          width: z.number(),
          height: z.number(),
        }),
      ])
    ),
    checkpointId: z.string().optional(),
  }),
  messageBase.extend({
    type: z.literal('assistant'),
    turnId: z.string(),
    content: z.string(),
    state: z.enum(['complete', 'cancelled', 'error']),
  }),
  messageBase.extend({
    type: z.literal('tool-call'),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.record(z.unknown()).optional(),
    result: z.unknown(),
    errorText: z.string().optional(),
    state: z.enum(['pending', 'completed', 'error', 'denied']),
  }),
]);
const attachment = z.object({
  id: z.string(),
  filename: z.string(),
  sourceMimeType: z.string(),
  normalizedMimeType: z
    .string()
    .regex(/^image\/(jpeg|png|webp)$/)
    .optional(),
  normalizedData: z
    .string()
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .optional(),
  status: z.enum(['ready', 'error']),
  sourceSurface: z.enum(['welcome', 'ai_panel', 'viewer_annotation', 'unknown']).optional(),
  sizeBytes: z.number(),
  dedupeKey: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  errorMessage: z.string().optional(),
});
const conversation = z.object({
  id: z.string(),
  lastUsed: z.number(),
  messages: z.array(message),
  draft: z.object({
    text: z.string(),
    attachmentIds: z.array(z.string()),
    comments: z.array(comment).optional(),
  }),
  attachments: z.record(attachment),
  checkpoints: z.record(z.object({ path: relativePath, code: z.string() })),
  interrupted: z.boolean().optional(),
});
export const conversationsSchema = z
  .object({
    activeId: z.string().nullable(),
    conversations: z.array(conversation),
  })
  .refine(
    ({ activeId, conversations }) =>
      new Set(conversations.map(({ id }) => id)).size === conversations.length &&
      (activeId === null
        ? conversations.length === 0
        : conversations.some(({ id }) => id === activeId))
  );

export const EMPTY_CONVERSATIONS: ProjectConversations = { activeId: null, conversations: [] };

export const projectDocumentSchema = z
  .object({
    files: z.record(relativePath, z.string()),
    emptyFolders: z.array(relativePath),
    renderTargetPath: relativePath.nullable(),
    tabs: z.array(z.object({ id: z.string(), name: z.string(), projectPath: relativePath })).min(1),
    activeTabId: z.string(),
    ai: conversationsSchema,
  })
  .superRefine((document, context) => {
    const { tabs, files, activeTabId, renderTargetPath, emptyFolders } = document;
    const paths = Object.keys(files);
    if (
      new Set(tabs.map(({ id }) => id)).size !== tabs.length ||
      !tabs.some(({ id }) => id === activeTabId) ||
      tabs.some(({ projectPath }) => !hasFile(files, projectPath)) ||
      (renderTargetPath === null
        ? paths.some(isRenderableOpenScadFilePath)
        : !hasFile(files, renderTargetPath)) ||
      [...paths, ...emptyFolders].some((path) =>
        path
          .split('/')
          .some((_, index, parts) => index > 0 && hasFile(files, parts.slice(0, index).join('/')))
      ) ||
      emptyFolders.some(
        (path) => hasFile(files, path) || paths.some((file) => file.startsWith(path + '/'))
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Invalid project file tree, tabs, or render target',
      });
    }
  });

export type ProjectDocument = z.infer<typeof projectDocumentSchema>;
export type ProjectConversations = z.infer<typeof conversationsSchema>;
export type ProjectConversation = z.infer<typeof conversation>;
