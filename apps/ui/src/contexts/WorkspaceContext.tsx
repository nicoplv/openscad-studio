import { createContext, useContext } from 'react';
import type { ModelSelectionSurface } from '../analytics/runtime';
import type { Diagnostic } from '../platform/historyService';
import type { RenderKind } from '../hooks/useOpenScad';
import type { AddDraftFilesResult } from '../hooks/useAiAgent';
import type { AiPromptPanelRef } from '../components/AiPromptPanel';
import type { ViewerAnnotationAttachResult } from '../components/viewer-annotation';
import type { ViewerCommentAttachResult } from '../components/viewer-comment/useViewerCommentSession';
import type { AiProvider } from '../stores/apiKeyStore';
import type { Settings } from '../stores/settingsStore';
import type { WorkspaceTab } from '../stores/workspaceTypes';
import type {
  AiContextUsage,
  AiDraft,
  AttachmentStore,
  Message,
  ToolCall,
  VisionSupport,
  ViewerComment,
  ViewerCommentContext,
} from '../types/aiChat';

export interface WorkspaceState {
  // Editor
  source: string;
  updateSource: (code: string) => void;
  diagnostics: Diagnostic[];
  onManualRender: (() => void) | undefined;
  settings: Settings;
  editorFocusRequestKey: number;

  // Tabs
  tabs: WorkspaceTab[];
  activeTabId: string;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  onNewTab: () => void;
  onReorderTabs: (tabs: WorkspaceTab[]) => void;

  // Files
  onFileDoubleClick: (path: string) => void;
  onRenameFile: (oldPath: string, newName: string) => void;
  onDeleteFile: (path: string) => void;
  onDeleteFolder: (path: string) => void;
  onSetRenderTarget: (path: string) => void;
  onCreateFile: (parentDir: string) => Promise<string>;
  onCreateFolder: (parentDir: string, folderName: string) => Promise<void>;
  onMoveItem: (sourcePath: string, destFolderPath: string, isFolder: boolean) => void;
  onAddExternalFiles: (files: Record<string, string>, targetFolderPath: string) => void;

  // Preview
  previewSrc: string;
  previewKind: RenderKind;
  previewCommentContext: ViewerCommentContext;
  isRendering: boolean;
  error: string | undefined;
  renderReady: boolean;
  onPreviewVisualReady?: () => void;

  // AI
  isStreaming: boolean;
  streamingResponse: string | null;
  proposedDiff: unknown;
  aiError: string | null;
  isApplyingDiff: boolean;
  messages: Message[];
  draft: AiDraft;
  attachments: AttachmentStore;
  draftErrors: string[];
  draftVisionBlockMessage: string | null;
  draftVisionWarningMessage: string | null;
  canSubmitDraft: boolean;
  isProcessingAttachments: boolean;
  currentToolCalls: ToolCall[];
  currentProvider: AiProvider;
  currentModel: string;
  currentModelVisionSupport: VisionSupport;
  lastContextUsage: AiContextUsage | null;
  availableProviders: AiProvider[];
  submitDraft: () => void;
  setDraftText: (text: string) => void;
  addDraftFiles: (
    files: File[],
    sourceSurface?: ModelSelectionSurface
  ) => Promise<AddDraftFilesResult | undefined>;
  removeDraftAttachment: (attachmentId: string, sourceSurface?: ModelSelectionSurface) => void;
  removeDraftComment: (commentId: string) => void;
  hasCurrentModelApiKey: boolean;
  canAttachViewerAnnotation: boolean;
  attachViewerAnnotationFile: (file: File) => Promise<ViewerAnnotationAttachResult>;
  attachViewerComment: (comment: ViewerComment) => Promise<ViewerCommentAttachResult>;
  cancelStream: () => void;
  acceptDiff: () => void;
  rejectDiff: () => void;
  clearAiError: () => void;
  newConversation: () => void;
  selectConversation: (id: string) => void;
  conversationList: { id: string; title: string }[];
  currentConversationId: string | null;
  interrupted: boolean;
  setCurrentModel: (
    model: string,
    sourceSurface?: ModelSelectionSurface,
    provider?: AiProvider
  ) => void;
  handleRestoreCheckpoint: (checkpointId: string, truncatedMessages: Message[]) => boolean;
  aiPromptPanelRef: React.RefObject<AiPromptPanelRef | null>;

  onAcceptDiff: () => void;
  onRejectDiff: () => void;
  onOpenAiSettings: () => void;
  onOpenCustomizerAiRefine: () => void;
  onOpenExportDialog: () => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export const WorkspaceProvider = WorkspaceContext.Provider;

// eslint-disable-next-line react-refresh/only-export-components
export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return ctx;
}
