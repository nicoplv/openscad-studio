import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { type ToolSet, stepCountIs } from 'ai';
import { bucketCount, useAnalytics, type ModelSelectionSurface } from '../analytics/runtime';
import { historyService, eventBus, getPlatform } from '../platform';
import {
  getProjectState,
  getProjectStore,
  listProjectFiles as listProjectFilesFromState,
} from '../stores/projectStore';
import { requestRender } from '../stores/renderRequestStore';
import {
  createModel,
  SYSTEM_PROMPT,
  buildTools,
  type AiToolCallbacks,
  type CreateModelOptions,
} from '../services/aiService';
import {
  buildProjectRenderInputs,
  loadConfiguredLibraryAssets,
} from '../services/projectRenderInputs';
import {
  getApiKey,
  getOpenAiCompatibleConfig,
  getPreferredDefaultModelSelection,
  getProviderFromModel,
  getStoredModelSelection,
  setStoredModelSelection,
  useAvailableProviders,
  type AiProvider,
} from '../stores/apiKeyStore';
import type {
  AiDraft,
  AiContextUsage,
  AttachmentStore,
  Message,
  ToolCall,
  UserMessagePart,
  UserMessage,
  ViewerComment,
  VisionSupport,
} from '../types/aiChat';
import {
  getDraftCanSubmit,
  getDraftHasPendingAttachments,
  getReadyAttachmentIds,
  processAttachmentFiles,
} from '../utils/aiAttachments';
import { getVisionSupportForModelId, messagesToModelMessages } from '../utils/aiMessages';
import { prepareOpenAiCompatiblePreviewStep } from '../utils/aiPreviewImages';
import { getPreferredDefaultModel } from '../utils/aiModels';
import {
  createActiveTurnState,
  deriveCurrentToolCalls,
  deriveStreamingResponse,
  finalizeActiveTurn,
  finalizeConversationTurn,
  getUnreferencedAttachmentIds,
  reduceActiveTurnChunk,
  type ActiveTurnState,
} from '../utils/aiTurnState';
import { startAiStream } from '../services/aiStream';
import {
  FALLBACK_PREVIEW_SCENE_STYLE,
  type PreviewSceneStyle,
} from '../services/previewSceneConfig';
import { normalizeProjectRelativePath } from '../utils/projectFilePaths';
import { createRandomId } from '../utils/randomId';
import { updateSetting, loadSettings, type MeasurementUnit } from '../stores/settingsStore';
import {
  getProjectConversations,
  getProjectEpoch,
  setProjectConversations,
  useProjectSession,
} from '../services/projectLifecycle';
import {
  EMPTY_CONVERSATIONS,
  isValidProjectPath,
  type ProjectConversation,
} from '../stores/projectDocument';
import { getUserMessageText } from '../types/aiChat';

function extractErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function humanizeStreamError(errorText: string, provider?: AiProvider): string {
  if (/failed to fetch/i.test(errorText)) {
    if (provider === 'openai-compatible') {
      return 'Could not reach the OpenAI-compatible provider — check that the local server is running and allows browser requests.';
    }
    return 'Could not reach the AI service — check your internet connection.';
  }
  return `Failed: ${errorText}`;
}

function getContextOverflowUsage(errorText: string): AiContextUsage | null {
  const match = errorText.match(
    /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i
  );
  return match ? { inputTokens: Number(match[1]), contextLimit: Number(match[2]) } : null;
}

function extractApplyEditCheckpointId(output: unknown): string | null {
  if (typeof output === 'object' && output !== null && '__checkpointId' in output) {
    const checkpointId = (output as { __checkpointId?: unknown }).__checkpointId;
    return typeof checkpointId === 'string' ? checkpointId : null;
  }

  if (typeof output !== 'string') return null;

  const checkpointMatch = output.match(/\[CHECKPOINT:([\w-]+)\]/);
  return checkpointMatch?.[1] ?? null;
}

const EMPTY_DRAFT: AiDraft = {
  text: '',
  attachmentIds: [],
};

// Coding turns regularly need a few extra steps after the last tool call
// to produce a visible final summary for the user.
const MAX_AGENT_STEPS = 30;
const IS_DEV =
  typeof window !== 'undefined' &&
  !window.navigator.userAgent.includes('jsdom') &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const VIEWER_ANNOTATION_GUIDANCE_TEXT =
  'The attached viewer screenshot includes intentional user annotations. Colored boxes, ovals, circles, and freehand marks highlight the area to focus on and are not part of the OpenSCAD geometry unless the user explicitly asks about the annotations.';

function revokePreviewUrlsForIds(ids: string[], attachments: AttachmentStore) {
  for (const id of ids) {
    const attachment = attachments[id];
    if (attachment?.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }
}

function draftToUserParts(draft: AiDraft, attachments: AttachmentStore) {
  const parts: UserMessagePart[] = [];
  const readyAttachmentIds = getReadyAttachmentIds(draft, attachments);
  const trimmedText = draft.text.trim();
  const hasViewerAnnotationAttachment = readyAttachmentIds.some(
    (attachmentId) => attachments[attachmentId]?.sourceSurface === 'viewer_annotation'
  );

  if (hasViewerAnnotationAttachment) {
    parts.push({ type: 'text', text: VIEWER_ANNOTATION_GUIDANCE_TEXT });
  }

  if (trimmedText) {
    parts.push({ type: 'text', text: trimmedText });
  }

  for (const attachmentId of readyAttachmentIds) {
    const attachment = attachments[attachmentId];
    if (!attachment || attachment.status !== 'ready') continue;

    parts.push({
      type: 'image',
      attachmentId,
      filename: attachment.filename,
      mimeType: attachment.normalizedMimeType || attachment.sourceMimeType,
      width: attachment.width ?? 0,
      height: attachment.height ?? 0,
    });
  }

  for (const comment of draft.comments ?? []) {
    parts.push({ type: 'comment', comment });
  }

  return parts;
}

function getVisionBlockMessage(
  draft: AiDraft,
  attachments: AttachmentStore,
  visionSupport: VisionSupport
): string | null {
  if (getReadyAttachmentIds(draft, attachments).length === 0) {
    return null;
  }

  if (visionSupport === 'no') {
    return 'The selected model does not support image inputs. Switch to a vision-capable model to send attachments.';
  }

  return null;
}

function getVisionWarningMessage(
  draft: AiDraft,
  attachments: AttachmentStore,
  visionSupport: VisionSupport
): string | null {
  if (getReadyAttachmentIds(draft, attachments).length === 0 || visionSupport !== 'unknown') {
    return null;
  }

  return 'This model may reject image inputs. If the request fails, switch to a vision-capable model and try again.';
}

export interface AiAgentState {
  isStreaming: boolean;
  streamingResponse: string | null;
  proposedDiff: {
    diff: string;
    rationale: string;
  } | null;
  error: string | null;
  errorObject: Error | null;
  isApplyingDiff: boolean;
  messages: Message[];
  conversations: ProjectConversation[];
  interrupted: boolean;
  currentConversationId: string | null;
  currentToolCalls: ToolCall[];
  currentProvider: AiProvider;
  currentModel: string;
  currentModelVisionSupport: VisionSupport;
  lastContextUsage: AiContextUsage | null;
  draft: AiDraft;
  attachments: AttachmentStore;
  draftErrors: string[];
  isProcessingAttachments: boolean;
}

export interface AddDraftFilesResult {
  readyCount: number;
  errorCount: number;
  attachmentIds: string[];
  errors: string[];
}

interface UseAiAgentOptions {
  persistProject?: boolean;
  testOverrides?: {
    analytics?: ReturnType<typeof useAnalytics>;
    availableProviders?: ReturnType<typeof useAvailableProviders>;
    createModel?: typeof createModel;
    buildTools?: typeof buildTools;
    startAiStream?: typeof startAiStream;
    processAttachmentFiles?: typeof processAttachmentFiles;
    getVisionSupportForModelId?: typeof getVisionSupportForModelId;
    messagesToModelMessages?: typeof messagesToModelMessages;
    getPreferredDefaultModel?: typeof getPreferredDefaultModel;
    historyService?: typeof historyService;
    eventBus?: typeof eventBus;
    updateSetting?: typeof updateSetting;
    loadSettings?: typeof loadSettings;
  };
}

function conversationFields(conversation?: ProjectConversation) {
  const attachments: AttachmentStore = {};
  for (const [id, attachment] of Object.entries(conversation?.attachments ?? {})) {
    const { normalizedData, normalizedMimeType } = attachment;
    attachments[id] = {
      ...attachment,
      previewUrl:
        normalizedData && normalizedMimeType
          ? `data:${normalizedMimeType};base64,${normalizedData}`
          : undefined,
    };
  }

  return {
    currentConversationId: conversation?.id ?? createRandomId(),
    messages: conversation?.messages ?? [],
    draft: conversation?.draft ?? EMPTY_DRAFT,
    attachments,
    interrupted: conversation?.interrupted ?? false,
  };
}

function snapshotConversation(
  state: AiAgentState,
  lastUsed: number,
  checkpoints: ProjectConversation['checkpoints'],
  checkpointId?: string | null
): ProjectConversation {
  const id = state.currentConversationId ?? createRandomId();
  const attachments: ProjectConversation['attachments'] = {};
  for (const [key, { previewUrl, status, ...attachment }] of Object.entries(state.attachments)) {
    void previewUrl;
    if (status !== 'pending') attachments[key] = { ...attachment, status };
  }

  const messages = [...state.messages];
  if (state.isStreaming && checkpointId) {
    const index = messages.map(({ type }) => type).lastIndexOf('user');
    const prompt = messages[index];
    if (prompt?.type === 'user') messages[index] = { ...prompt, checkpointId };
  }
  if (state.isStreaming && state.streamingResponse) {
    const turnId = state.messages[state.messages.length - 1]?.id ?? id;
    messages.push({
      type: 'assistant',
      id: `${turnId}-partial`,
      turnId,
      timestamp: lastUsed,
      state: 'cancelled',
      content: state.streamingResponse,
    });
  }
  return {
    id,
    lastUsed,
    messages,
    draft: {
      ...state.draft,
      attachmentIds: state.draft.attachmentIds.filter((key) => key in attachments),
    },
    attachments,
    checkpoints,
    interrupted: state.isStreaming || state.interrupted,
  };
}

function hasConversationContent(conversation: ProjectConversation) {
  const { draft, messages } = conversation;
  return Boolean(
    messages.length || draft.text || draft.attachmentIds.length || draft.comments?.length
  );
}

export function useAiAgent(options: UseAiAgentOptions = {}) {
  const persistProject = options.persistProject ?? false;
  const projectEpoch = useProjectSession((state) => (persistProject ? state.epoch : 0));
  const activeEpoch = useRef(projectEpoch);
  const initialHistory = useRef(persistProject ? getProjectConversations() : EMPTY_CONVERSATIONS);
  const initialConversation = initialHistory.current.conversations.find(
    ({ id }) => id === initialHistory.current.activeId
  );
  const lastUsed = useRef(initialConversation?.lastUsed ?? Date.now());
  const checkpoints = useRef<ProjectConversation['checkpoints']>(
    initialConversation?.checkpoints ?? {}
  );
  const skipPublish = useRef(true);
  const defaultAnalytics = useAnalytics();
  const defaultAvailableProviders = useAvailableProviders();
  const overrides = options.testOverrides;
  const analytics = overrides?.analytics ?? defaultAnalytics;
  const availableProviders = overrides?.availableProviders ?? defaultAvailableProviders;
  const createModelImpl = overrides?.createModel ?? createModel;
  const buildToolsImpl = overrides?.buildTools ?? buildTools;
  const startAiStreamImpl = overrides?.startAiStream ?? startAiStream;
  const processAttachmentFilesImpl = overrides?.processAttachmentFiles ?? processAttachmentFiles;
  const getVisionSupportForModelIdImpl =
    overrides?.getVisionSupportForModelId ?? getVisionSupportForModelId;
  const messagesToModelMessagesImpl = overrides?.messagesToModelMessages ?? messagesToModelMessages;
  const historyServiceImpl = overrides?.historyService ?? historyService;
  const eventBusImpl = overrides?.eventBus ?? eventBus;
  const updateSettingImpl = overrides?.updateSetting ?? updateSetting;
  const loadSettingsImpl = overrides?.loadSettings ?? loadSettings;
  const initialSelection = getStoredModelSelection();
  const [state, setState] = useState<AiAgentState>(() => ({
    isStreaming: false,
    streamingResponse: null,
    proposedDiff: null,
    error: null,
    errorObject: null,
    isApplyingDiff: false,
    ...conversationFields(initialConversation),
    conversations: initialHistory.current.conversations.filter(
      ({ id }) => id !== initialHistory.current.activeId
    ),
    currentToolCalls: [],
    currentProvider: initialSelection.provider,
    currentModel: initialSelection.modelId,
    currentModelVisionSupport: getVisionSupportForModelIdImpl(initialSelection.modelId),
    lastContextUsage: null,
    draftErrors: [],
    isProcessingAttachments: false,
  }));

  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  const capturePreviewRef = useRef<(() => Promise<string | null>) | null>(null);
  const preview3dUrlRef = useRef<string | null>(null);
  const previewSceneStyleRef = useRef<PreviewSceneStyle>(FALLBACK_PREVIEW_SCENE_STYLE);
  const useModelColorsRef = useRef<boolean>(loadSettingsImpl().viewer.showModelColors);
  const measurementUnitRef = useRef<MeasurementUnit>(loadSettingsImpl().viewer.measurementUnit);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeTurnRef = useRef<ActiveTurnState | null>(null);
  const committedMessagesRef = useRef<Message[]>(state.messages);
  const activeTurnDraftRef = useRef<{
    submittedDraft: AiDraft;
    submittedReadyIds: string[];
  } | null>(null);
  const pendingCheckpointIdRef = useRef<string | null>(null);
  const didReceiveResponseRef = useRef(false);
  const requestStartedAtRef = useRef<number | null>(null);

  const setActiveConversation = useCallback(
    (
      conversation: ProjectConversation | undefined,
      conversations: ProjectConversation[],
      reopening = false
    ) => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      activeTurnRef.current = null;
      activeTurnDraftRef.current = null;
      pendingCheckpointIdRef.current = null;
      revokePreviewUrlsForIds(
        Object.keys(stateRef.current.attachments),
        stateRef.current.attachments
      );
      const fields = conversationFields(conversation);
      committedMessagesRef.current = fields.messages;
      checkpoints.current = conversation?.checkpoints ?? {};
      lastUsed.current = reopening
        ? (conversation?.lastUsed ?? Date.now())
        : Math.max(Date.now(), lastUsed.current + 1);
      setState((prev) => ({
        ...prev,
        ...fields,
        conversations,
        isStreaming: false,
        isProcessingAttachments: false,
        streamingResponse: null,
        error: null,
        errorObject: null,
        currentToolCalls: [],
        draftErrors: [],
        lastContextUsage: null,
      }));
    },
    []
  );

  useLayoutEffect(() => {
    if (!persistProject) return;
    if (activeEpoch.current !== projectEpoch) {
      activeEpoch.current = projectEpoch;
      skipPublish.current = true;
      const history = getProjectConversations();
      setActiveConversation(
        history.conversations.find(({ id }) => id === history.activeId),
        history.conversations.filter(({ id }) => id !== history.activeId),
        true
      );
      return;
    }
    if (skipPublish.current) {
      skipPublish.current = false;
      return;
    }
    const current = snapshotConversation(
      stateRef.current,
      lastUsed.current,
      checkpoints.current,
      pendingCheckpointIdRef.current
    );
    const conversations = [...state.conversations, current];
    if (!state.conversations.length && !hasConversationContent(current)) {
      setProjectConversations(EMPTY_CONVERSATIONS);
      return;
    }
    setProjectConversations({ activeId: current.id, conversations });
  }, [
    persistProject,
    projectEpoch,
    setActiveConversation,
    state.attachments,
    state.conversations,
    state.currentConversationId,
    state.draft,
    state.interrupted,
    state.isStreaming,
    state.messages,
    state.streamingResponse,
  ]);

  useEffect(() => {
    if (!state.isStreaming) {
      committedMessagesRef.current = state.messages;
    }
  }, [state.isStreaming, state.messages]);

  const callbacks: AiToolCallbacks = useMemo(
    () => ({
      captureCurrentView: async () => {
        if (capturePreviewRef.current) {
          return capturePreviewRef.current();
        }
        return null;
      },
      get3dPreviewUrl: () => preview3dUrlRef.current,
      getPreviewSceneStyle: () => previewSceneStyleRef.current,
      getUseModelColors: () => useModelColorsRef.current,
      listProjectFiles: () => listProjectFilesFromState(getProjectState()),
      readProjectFile: (path: string) => {
        const normalizedPath = normalizeProjectRelativePath(path);
        if (!normalizedPath) return null;
        const state = getProjectState();
        return state.files[normalizedPath]?.content ?? null;
      },
      getRenderTargetPath: () => getProjectState().renderTargetPath,
      getRenderValidationInputs: async () => {
        const state = getProjectState();
        const platform = getPlatform();
        const settings = loadSettingsImpl();
        const { libraryFiles, libraryPaths } = await loadConfiguredLibraryAssets(
          settings.library,
          platform
        );

        const renderInputs = await buildProjectRenderInputs({
          state,
          libraryFiles,
          libraryPaths,
          platform: state.projectRoot ? platform : undefined,
        });

        return {
          code: renderInputs.code,
          renderTargetPath: renderInputs.renderTargetPath,
          renderOptions: renderInputs.renderOptions,
        };
      },
      createProjectFile: (path: string, content: string) => {
        const normalizedPath = normalizeProjectRelativePath(path);
        if (!normalizedPath || !isValidProjectPath(normalizedPath)) return false;
        const state = getProjectState();
        if (normalizedPath in state.files) return false;
        getProjectStore().getState().addFile(normalizedPath, content);

        // Auto-persist to disk when project is disk-backed
        const { projectRoot } = getProjectState();
        if (projectRoot) {
          const platform = getPlatform();
          void platform
            .createDirectory(`${projectRoot}/${normalizedPath.split('/').slice(0, -1).join('/')}`)
            .then(() => platform.writeTextFile(`${projectRoot}/${normalizedPath}`, content))
            .then(() => {
              const project = getProjectState();
              if (project.projectRoot === projectRoot)
                getProjectStore().getState().markFileSaved(normalizedPath, content);
            })
            .catch((err) => console.warn('[createProjectFile] Failed to persist to disk:', err));
        }

        return true;
      },
      editProjectFile: (path: string, oldString: string, newString: string) => {
        const state = getProjectState();
        const file = state.files[path];
        if (!file) return `File not found: ${path}`;

        const occurrences = file.content.split(oldString).length - 1;
        if (occurrences === 0) return 'old_string not found in the file';
        if (occurrences > 1) return `old_string found ${occurrences} times — it must be unique`;

        const newContent = file.content.replace(oldString, newString);
        getProjectStore().getState().updateFileContent(path, newContent);

        // Auto-persist to disk when project is disk-backed
        const { projectRoot } = getProjectState();
        if (projectRoot) {
          const platform = getPlatform();
          void platform
            .writeTextFile(`${projectRoot}/${path}`, newContent)
            .then(() => {
              const project = getProjectState();
              if (project.projectRoot === projectRoot)
                getProjectStore().getState().markFileSaved(path, newContent);
            })
            .catch((err) => console.warn('[editProjectFile] Failed to persist to disk:', err));
        }

        return null;
      },
      requestRender: (trigger: string, opts) => {
        requestRender(trigger as Parameters<typeof requestRender>[0], opts);
      },
      setRenderTarget: (path: string) => {
        const state = getProjectState();
        if (!(path in state.files)) return false;
        getProjectStore().getState().setRenderTarget(path);
        return true;
      },
      getMeasurementUnit: () => measurementUnitRef.current,
      setMeasurementUnit: (unit: MeasurementUnit) => {
        measurementUnitRef.current = unit;
        updateSettingImpl('viewer', { measurementUnit: unit });
      },
    }),
    [loadSettingsImpl, updateSettingImpl]
  );

  const updateCapturePreview = useCallback((fn: (() => Promise<string | null>) | null) => {
    capturePreviewRef.current = fn;
  }, []);

  const update3dPreviewUrl = useCallback((url: string | null) => {
    preview3dUrlRef.current = url;
  }, []);

  const updatePreviewSceneStyle = useCallback((sceneStyle: PreviewSceneStyle) => {
    previewSceneStyleRef.current = sceneStyle;
  }, []);

  const updateUseModelColors = useCallback((enabled: boolean) => {
    useModelColorsRef.current = enabled;
  }, []);

  const loadModelAndProviders = useCallback(() => {
    const storedSelection = getStoredModelSelection();
    const resolvedSelection =
      availableProviders.length === 0 || availableProviders.includes(storedSelection.provider)
        ? storedSelection
        : getPreferredDefaultModelSelection(availableProviders);

    if (
      resolvedSelection.provider !== storedSelection.provider ||
      resolvedSelection.modelId !== storedSelection.modelId
    ) {
      setStoredModelSelection(resolvedSelection);
    }

    setState((prev) => ({
      ...prev,
      currentProvider: resolvedSelection.provider,
      currentModel: resolvedSelection.modelId,
      currentModelVisionSupport: getVisionSupportForModelIdImpl(resolvedSelection.modelId),
      lastContextUsage: null,
    }));
    if (IS_DEV) {
      console.log(
        '[useAiAgent] Loaded model:',
        resolvedSelection.modelId,
        'Provider:',
        resolvedSelection.provider,
        'Available providers:',
        availableProviders
      );
    }
  }, [availableProviders, getVisionSupportForModelIdImpl]);

  useEffect(() => {
    loadModelAndProviders();
  }, [loadModelAndProviders]);

  const logTurnWarnings = useCallback((warnings: string[]) => {
    if (!IS_DEV || warnings.length === 0) return;
    for (const warning of warnings) {
      console.warn('[useAiAgent]', warning);
    }
  }, []);

  const syncActiveTurnState = useCallback((activeTurn: ActiveTurnState | null) => {
    setState((prev) => ({
      ...prev,
      messages: activeTurn
        ? [...committedMessagesRef.current, ...activeTurn.persistedMessages]
        : committedMessagesRef.current,
      currentToolCalls: activeTurn ? deriveCurrentToolCalls(activeTurn) : [],
      streamingResponse: activeTurn ? deriveStreamingResponse(activeTurn) : null,
    }));
  }, []);

  const finalizeStreamTurn = useCallback(
    (
      activeTurn: ActiveTurnState,
      options: {
        reason: 'complete' | 'cancelled' | 'error';
        errorText?: string | null;
        errorObject?: Error | null;
        restoreDraft?: boolean;
        completionNotice?: string | null;
      }
    ) => {
      const finalizedTurn = finalizeActiveTurn(activeTurn, {
        reason: options.reason,
        errorText: options.errorText,
      });
      logTurnWarnings(finalizedTurn.warnings);

      const submittedDraft = activeTurnDraftRef.current?.submittedDraft;
      const submittedReadyIds = activeTurnDraftRef.current?.submittedReadyIds ?? [];

      setState((prev) => {
        if (submittedDraft) {
          const transientIds = submittedDraft.attachmentIds.filter(
            (id) => !submittedReadyIds.includes(id)
          );
          revokePreviewUrlsForIds(transientIds, prev.attachments);
        }

        const nextConversation = finalizeConversationTurn({
          baseMessages: committedMessagesRef.current,
          attachments: prev.attachments,
          activeTurn: finalizedTurn.state,
          submittedAttachmentIds: submittedDraft?.attachmentIds ?? [],
          submittedReadyIds,
          checkpointId: pendingCheckpointIdRef.current,
        });
        const nextMessages = options.completionNotice
          ? [
              ...nextConversation.messages,
              {
                type: 'assistant' as const,
                id: createRandomId(),
                turnId: activeTurn.turnId,
                content: options.completionNotice,
                state: 'complete' as const,
                timestamp: Date.now(),
              },
            ]
          : nextConversation.messages;

        committedMessagesRef.current = nextMessages;
        activeTurnRef.current = null;
        activeTurnDraftRef.current = null;
        pendingCheckpointIdRef.current = null;

        return {
          ...prev,
          isStreaming: false,
          streamingResponse: null,
          currentToolCalls: [],
          error: options.errorText
            ? humanizeStreamError(options.errorText, stateRef.current.currentProvider)
            : null,
          errorObject: options.errorObject ?? null,
          messages: nextMessages,
          attachments: nextConversation.attachments,
          draft: options.restoreDraft && submittedDraft ? submittedDraft : prev.draft,
        };
      });

      const durationMs =
        requestStartedAtRef.current === null
          ? undefined
          : Math.round(performance.now() - requestStartedAtRef.current);
      requestStartedAtRef.current = null;

      const toolMessages = finalizedTurn.state.completedToolCalls;
      const toolNamesUsed = Array.from(new Set(toolMessages.map((tool) => tool.toolName))).sort();
      const appliedEditCount = toolMessages.filter((tool) => tool.toolName === 'apply_edit').length;
      const baseProperties = {
        provider: stateRef.current.currentProvider,
        model_id: stateRef.current.currentModel,
        duration_ms: durationMs,
        tool_call_count: toolMessages.length,
        tool_names_used: toolNamesUsed,
        applied_edit_count: appliedEditCount,
      };

      if (options.reason === 'cancelled') {
        analytics.track('ai request cancelled', baseProperties);
      } else {
        analytics.track('ai request completed', {
          ...baseProperties,
          finish_reason: options.completionNotice ? 'step-budget' : options.reason,
          had_error: options.reason === 'error',
        });
      }
    },
    [analytics, logTurnWarnings]
  );

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      revokePreviewUrlsForIds(
        Object.keys(stateRef.current.attachments),
        stateRef.current.attachments
      );
    };
  }, []);

  const setDraftText = useCallback((text: string) => {
    setState((prev) => ({
      ...prev,
      draft: {
        ...prev.draft,
        text,
      },
      draftErrors: [],
    }));
  }, []);

  const setDraft = useCallback((draft: AiDraft) => {
    setState((prev) => {
      const nextAttachments = { ...prev.attachments };
      const nextAttachmentIds = new Set(draft.attachmentIds);

      for (const id of getUnreferencedAttachmentIds(prev.draft.attachmentIds, prev.messages)) {
        if (nextAttachmentIds.has(id)) continue;
        const attachment = nextAttachments[id];
        if (attachment?.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
        delete nextAttachments[id];
      }

      return {
        ...prev,
        attachments: nextAttachments,
        draft,
        draftErrors: [],
      };
    });
  }, []);

  const addDraftFiles = useCallback(
    async (files: File[], sourceSurface: ModelSelectionSurface = 'unknown') => {
      if (files.length === 0) return;

      const snapshot = stateRef.current;
      const epoch = getProjectEpoch();
      setState((prev) => ({
        ...prev,
        isProcessingAttachments: true,
        draftErrors: [],
      }));

      const result = await processAttachmentFilesImpl(
        files,
        snapshot.draft,
        snapshot.attachments,
        sourceSurface
      );
      if (
        (persistProject && epoch !== getProjectEpoch()) ||
        stateRef.current.currentConversationId !== snapshot.currentConversationId
      ) {
        for (const attachment of result.attachments) {
          if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
        }
        return;
      }
      const readyCount = result.attachments.filter(
        (attachment) => attachment.status === 'ready'
      ).length;
      const errorCount = result.attachments.length - readyCount;

      setState((prev) => {
        const nextAttachments = { ...prev.attachments };
        const nextAttachmentIds = [...prev.draft.attachmentIds];

        for (const attachment of result.attachments) {
          nextAttachments[attachment.id] = attachment;
          nextAttachmentIds.push(attachment.id);
        }

        return {
          ...prev,
          isProcessingAttachments: false,
          attachments: nextAttachments,
          draft: {
            ...prev.draft,
            attachmentIds: nextAttachmentIds,
          },
          draftErrors: result.errors,
        };
      });

      analytics.track('attachment added', {
        source_surface: sourceSurface,
        selected_count: files.length,
        ready_count: readyCount,
        error_count: errorCount,
      });

      return {
        readyCount,
        errorCount,
        attachmentIds: result.attachments.map((attachment) => attachment.id),
        errors: [...result.errors],
      } satisfies AddDraftFilesResult;
    },
    [analytics, persistProject, processAttachmentFilesImpl]
  );

  const removeDraftAttachment = useCallback(
    (attachmentId: string, sourceSurface: ModelSelectionSurface = 'unknown') => {
      setState((prev) => {
        const attachment = prev.attachments[attachmentId];
        if (attachment?.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }

        const nextAttachments = { ...prev.attachments };
        delete nextAttachments[attachmentId];

        return {
          ...prev,
          attachments: nextAttachments,
          draft: {
            ...prev.draft,
            attachmentIds: prev.draft.attachmentIds.filter((id) => id !== attachmentId),
          },
        };
      });

      analytics.track('attachment removed', {
        source_surface: sourceSurface,
      });
    },
    [analytics]
  );

  const clearDraft = useCallback(() => {
    setState((prev) => {
      const removableIds = getUnreferencedAttachmentIds(prev.draft.attachmentIds, prev.messages);
      revokePreviewUrlsForIds(removableIds, prev.attachments);
      const nextAttachments = { ...prev.attachments };
      for (const id of removableIds) {
        delete nextAttachments[id];
      }

      return {
        ...prev,
        attachments: nextAttachments,
        draft: EMPTY_DRAFT,
        draftErrors: [],
        isProcessingAttachments: false,
      };
    });
  }, []);

  const addDraftComment = useCallback((comment: ViewerComment) => {
    setState((prev) => ({
      ...prev,
      draft: { ...prev.draft, comments: [...(prev.draft.comments ?? []), comment] },
      draftErrors: [],
    }));
  }, []);

  const removeDraftComment = useCallback((commentId: string) => {
    setState((prev) => ({
      ...prev,
      draft: {
        ...prev.draft,
        comments: prev.draft.comments?.filter((comment) => comment.id !== commentId),
      },
    }));
  }, []);

  const submitDraft = useCallback(
    async (draftOverride?: AiDraft) => {
      const currentState = stateRef.current;
      const draft = draftOverride ?? currentState.draft;
      const draftParts = draftToUserParts(draft, currentState.attachments);

      if (!draftParts.length || getDraftHasPendingAttachments(draft, currentState.attachments)) {
        return;
      }

      const visionBlockMessage = getVisionBlockMessage(
        draft,
        currentState.attachments,
        currentState.currentModelVisionSupport
      );
      if (visionBlockMessage) {
        setState((prev) => ({
          ...prev,
          draftErrors: [visionBlockMessage],
        }));
        return;
      }

      const provider = currentState.currentProvider;
      const modelOptions: CreateModelOptions = {};
      let apiKey = getApiKey(provider);

      if (provider === 'openai-compatible') {
        const config = getOpenAiCompatibleConfig();
        modelOptions.baseUrl = config.baseUrl;
        apiKey = config.apiKey ?? 'local';

        if (!config.baseUrl || !currentState.currentModel.trim()) {
          setState((prev) => ({
            ...prev,
            error: 'Configure an OpenAI-compatible provider in Settings first',
          }));
          return;
        }
      }

      if (!apiKey) {
        setState((prev) => ({
          ...prev,
          error: 'Please set your API key in Settings first',
        }));
        return;
      }

      const userMessage: UserMessage = {
        type: 'user',
        id: createRandomId(),
        parts: draftParts,
        timestamp: Date.now(),
      };

      const updatedMessages = [...currentState.messages, userMessage];
      const submittedDraft = draft;
      const submittedReadyIds = getReadyAttachmentIds(draft, currentState.attachments);
      const turnId = createRandomId();
      const activeTurn = createActiveTurnState(turnId, userMessage.id);

      committedMessagesRef.current = updatedMessages;
      activeTurnRef.current = activeTurn;
      activeTurnDraftRef.current = {
        submittedDraft,
        submittedReadyIds,
      };
      setState((prev) => ({
        ...prev,
        isStreaming: true,
        interrupted: false,
        streamingResponse: null,
        error: null,
        messages: updatedMessages,
        currentToolCalls: [],
        draft: EMPTY_DRAFT,
        draftErrors: [],
      }));
      pendingCheckpointIdRef.current = null;
      didReceiveResponseRef.current = false;
      requestStartedAtRef.current = performance.now();
      analytics.track('ai request submitted', {
        provider,
        model_id: currentState.currentModel,
        attachment_count: submittedReadyIds.length,
        has_project_files: callbacks.listProjectFiles().length > 0,
        prompt_length_bucket: bucketCount(draft.text.trim().length, [20, 80, 200, 500]),
        conversation_length_bucket: bucketCount(updatedMessages.length, [2, 5, 10, 20]),
      });

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const updateContextUsage = (usage: AiContextUsage | null) => {
        if (!usage || provider !== 'openai-compatible') return;
        setState((prev) =>
          prev.currentProvider === provider && prev.currentModel === currentState.currentModel
            ? { ...prev, lastContextUsage: { ...prev.lastContextUsage, ...usage } }
            : prev
        );
      };

      try {
        const model =
          provider === 'openai-compatible'
            ? createModelImpl(provider, apiKey, currentState.currentModel, modelOptions)
            : createModelImpl(provider, apiKey, currentState.currentModel);
        const modelMessages = messagesToModelMessagesImpl(
          updatedMessages,
          currentState.attachments
        );

        const measurementUnit = callbacks.getMeasurementUnit();
        const unitLabels: Record<MeasurementUnit, string> = {
          mm: 'millimeters',
          cm: 'centimeters',
          in: 'inches',
          units: 'dimensionless',
        };
        const dynamicSystem = `${SYSTEM_PROMPT}\n\nCurrent measurement unit: ${measurementUnit} (${unitLabels[measurementUnit]}) — all displayed dimensions use this unit`;

        const epoch = getProjectEpoch();
        const tools: ToolSet = buildToolsImpl(callbacks);
        for (const [name, tool] of Object.entries(tools)) {
          const execute = tool.execute;
          if (!execute) continue;
          tools[name] = {
            ...tool,
            execute: (input, options) => {
              if (
                abortController.signal.aborted ||
                (persistProject && getProjectEpoch() !== epoch)
              ) {
                throw new Error('The conversation is no longer active.');
              }
              return execute(input, options);
            },
          };
        }

        const result = await startAiStreamImpl({
          model,
          system: dynamicSystem,
          messages: modelMessages,
          tools,
          prepareStep:
            provider === 'openai-compatible' ? prepareOpenAiCompatiblePreviewStep : undefined,
          stopWhen: stepCountIs(MAX_AGENT_STEPS),
          abortSignal: abortController.signal,
        });

        let streamErrorText: string | null = null;
        let streamErrorObject: Error | null = null;
        let streamFinishReason: string | null = null;

        for await (const chunk of result.fullStream) {
          if (abortController.signal.aborted) break;

          if (IS_DEV) {
            console.log('[useAiAgent] Stream chunk:', chunk.type);
          }

          if (
            chunk.type === 'text-start' ||
            chunk.type === 'text-delta' ||
            chunk.type === 'text-end' ||
            chunk.type === 'tool-input-start' ||
            chunk.type === 'tool-call' ||
            chunk.type === 'tool-result' ||
            chunk.type === 'tool-error' ||
            chunk.type === 'tool-output-denied'
          ) {
            didReceiveResponseRef.current = true;
          }

          const currentActiveTurn = activeTurnRef.current;
          if (!currentActiveTurn) break;

          const turnUpdate = reduceActiveTurnChunk(currentActiveTurn, chunk);
          activeTurnRef.current = turnUpdate.state;
          logTurnWarnings(turnUpdate.warnings);

          if (
            chunk.type === 'tool-result' &&
            chunk.toolName === 'apply_edit' &&
            pendingCheckpointIdRef.current === null
          ) {
            // The restore button is turn-scoped: it should return to the code
            // from before this user request, not before the last edit in the turn.
            const checkpointId = extractApplyEditCheckpointId(chunk.output);
            if (checkpointId) {
              pendingCheckpointIdRef.current = checkpointId;
              const checkpoint = historyServiceImpl.getById?.(checkpointId);
              if (checkpoint?.projectPath) {
                checkpoints.current = {
                  ...checkpoints.current,
                  [checkpointId]: { path: checkpoint.projectPath, code: checkpoint.code },
                };
              }
            }
          }

          syncActiveTurnState(turnUpdate.state);

          if (chunk.type === 'finish-step' && chunk.usage?.inputTokens !== undefined) {
            updateContextUsage({ inputTokens: chunk.usage.inputTokens });
          }

          if (chunk.type === 'error') {
            streamErrorText = extractErrorText(chunk.error);
            updateContextUsage(getContextOverflowUsage(streamErrorText));
            streamErrorObject =
              chunk.error instanceof Error ? chunk.error : new Error(streamErrorText);
            console.error('[useAiAgent] Stream error:', chunk.error);
            break;
          }

          if (chunk.type === 'finish') {
            streamFinishReason = chunk.finishReason;
          }
        }

        if (abortController.signal.aborted) {
          if (IS_DEV) console.log('[useAiAgent] Stream was cancelled');
          return;
        }

        if (activeTurnRef.current) {
          const completionNotice =
            !streamErrorText && streamFinishReason === 'tool-calls'
              ? `Stopped before the final AI summary because the tool step budget (${MAX_AGENT_STEPS}) was reached.`
              : null;
          finalizeStreamTurn(activeTurnRef.current, {
            reason: streamErrorText ? 'error' : 'complete',
            errorText: streamErrorText,
            errorObject: streamErrorObject,
            restoreDraft: Boolean(streamErrorText) && !didReceiveResponseRef.current,
            completionNotice,
          });
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          if (IS_DEV) console.log('[useAiAgent] Stream was cancelled');
          return;
        }

        console.error('[useAiAgent] Error submitting prompt:', error);
        const errorText = extractErrorText(error);
        updateContextUsage(getContextOverflowUsage(errorText));
        const errorObject = error instanceof Error ? error : new Error(errorText);

        if (activeTurnRef.current) {
          finalizeStreamTurn(activeTurnRef.current, {
            reason: 'error',
            errorText,
            errorObject,
            restoreDraft: !didReceiveResponseRef.current,
          });
        } else {
          setState((prev) => ({
            ...prev,
            error: humanizeStreamError(errorText, currentState.currentProvider),
            errorObject,
            isStreaming: false,
            streamingResponse: null,
            currentToolCalls: [],
            draft: didReceiveResponseRef.current ? prev.draft : submittedDraft,
          }));
        }
      } finally {
        if (abortControllerRef.current === abortController) abortControllerRef.current = null;
      }
    },
    [
      analytics,
      callbacks,
      createModelImpl,
      finalizeStreamTurn,
      historyServiceImpl,
      logTurnWarnings,
      messagesToModelMessagesImpl,
      startAiStreamImpl,
      syncActiveTurnState,
      buildToolsImpl,
      persistProject,
    ]
  );

  const submitPrompt = useCallback(
    async (prompt: string) => {
      await submitDraft({ text: prompt, attachmentIds: [] });
    },
    [submitDraft]
  );

  const cancelStream = useCallback(() => {
    if (IS_DEV) console.log('[useAiAgent] Cancelling stream...');
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const activeTurn = activeTurnRef.current;
    if (activeTurn) {
      finalizeStreamTurn(activeTurn, { reason: 'cancelled' });
      return;
    }
    setState((prev) => ({
      ...prev,
      isStreaming: false,
      streamingResponse: null,
      currentToolCalls: [],
    }));
    pendingCheckpointIdRef.current = null;
  }, [finalizeStreamTurn]);

  const acceptDiff = useCallback(() => {}, []);
  const rejectDiff = useCallback(() => {}, []);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null, errorObject: null }));
  }, []);

  const setCurrentModel = useCallback(
    (
      model: string,
      sourceSurface: ModelSelectionSurface = 'unknown',
      provider: AiProvider = getProviderFromModel(model)
    ) => {
      if (IS_DEV) console.log('[useAiAgent] Setting current model to:', model, provider);
      setState((prev) => ({
        ...prev,
        currentProvider: provider,
        currentModel: model,
        currentModelVisionSupport: getVisionSupportForModelIdImpl(model),
        lastContextUsage: null,
      }));
      setStoredModelSelection({ provider, modelId: model });
      analytics.track('model selected', {
        provider,
        model_id: model,
        source_surface: sourceSurface,
      });
    },
    [analytics, getVisionSupportForModelIdImpl]
  );

  const selectConversation = useCallback(
    (id?: string) => {
      const current = stateRef.current;
      if (
        current.isStreaming ||
        current.isProcessingAttachments ||
        id === current.currentConversationId
      )
        return;
      const next = current.conversations.find((conversation) => conversation.id === id);
      if (id && !next) return;

      const snapshot = snapshotConversation(current, lastUsed.current, checkpoints.current);
      const conversations = current.conversations.filter((conversation) => conversation.id !== id);
      if (hasConversationContent(snapshot)) conversations.push(snapshot);
      setActiveConversation(next, conversations);
    },
    [setActiveConversation]
  );

  const newConversation = useCallback(() => {
    const current = stateRef.current;
    if (current.isStreaming) return;
    analytics.track('conversation started', {
      source_surface: 'ai_panel',
      had_messages: current.messages.length > 0,
      had_draft_text: current.draft.text.trim().length > 0,
      draft_attachment_count: current.draft.attachmentIds.length,
      previous_message_count_bucket: bucketCount(current.messages.length, [1, 3, 8, 20]),
    });
    selectConversation();
  }, [analytics, selectConversation]);

  const conversationList = useMemo(() => {
    const active = {
      id: state.currentConversationId ?? '',
      lastUsed: lastUsed.current,
      messages: state.messages,
    };
    return [...state.conversations, active]
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .map(({ id, messages }) => {
        const prompt = messages.find((message): message is UserMessage => message.type === 'user');
        return {
          id,
          title:
            (prompt ? getUserMessageText(prompt).trim().slice(0, 80) : '') || 'New conversation',
        };
      });
  }, [state.conversations, state.currentConversationId, state.messages]);

  const handleRestoreCheckpoint = useCallback(
    (checkpointId: string, truncatedMessages: Message[]) => {
      if (stateRef.current.isStreaming) return false;
      if (IS_DEV) console.log('[useAiAgent] Restoring checkpoint:', checkpointId);

      const saved = checkpoints.current[checkpointId];
      if (persistProject) {
        const project = getProjectStore().getState();
        if (!saved || !project.files[saved.path]) return false;
        project.updateFileContent(saved.path, saved.code);
        project.setCustomizerBase(saved.path, saved.code);
        requestRender('history_restore', { immediate: true });
      } else {
        const checkpoint = historyServiceImpl.restoreTo(checkpointId);
        if (checkpoint) {
          eventBusImpl.emit('code-updated', { code: checkpoint.code, source: 'history' });
          eventBusImpl.emit('history:restore', { code: checkpoint.code });
        } else {
          console.error('[useAiAgent] Failed to restore checkpoint: not found', checkpointId);
        }
      }

      committedMessagesRef.current = truncatedMessages;
      activeTurnRef.current = null;
      activeTurnDraftRef.current = null;

      setState((prev) => ({
        ...prev,
        messages: truncatedMessages,
        lastContextUsage: null,
      }));
      analytics.track('checkpoint restored', {
        had_later_messages: stateRef.current.messages.length > truncatedMessages.length,
      });
      return true;
    },
    [analytics, eventBusImpl, historyServiceImpl, persistProject]
  );

  return {
    ...state,
    availableProviders,
    submitPrompt,
    submitDraft,
    cancelStream,
    acceptDiff,
    rejectDiff,
    clearError,
    newConversation,
    selectConversation,
    conversationList,
    setCurrentModel,
    loadModelAndProviders,
    handleRestoreCheckpoint,
    updateCapturePreview,
    update3dPreviewUrl,
    updatePreviewSceneStyle,
    updateUseModelColors,
    setDraftText,
    setDraft,
    clearDraft,
    addDraftFiles,
    removeDraftAttachment,
    addDraftComment,
    removeDraftComment,
    canSubmitDraft: getDraftCanSubmit(state.draft, state.attachments),
    draftVisionBlockMessage: getVisionBlockMessage(
      state.draft,
      state.attachments,
      state.currentModelVisionSupport
    ),
    draftVisionWarningMessage: getVisionWarningMessage(
      state.draft,
      state.attachments,
      state.currentModelVisionSupport
    ),
  };
}
