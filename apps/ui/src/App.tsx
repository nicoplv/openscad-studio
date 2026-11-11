import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { DockviewReact } from 'dockview';
import type { DockviewReadyEvent } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { ExportDialog } from './components/ExportDialog';
import { ShareDialog } from './components/ShareDialog';
import { ShareBanner } from './components/ShareBanner';
import type { AiPromptPanelRef } from './components/AiPromptPanel';
import { SettingsDialog, type SettingsSection } from './components/SettingsDialog';
import { WebMenuBar } from './components/WebMenuBar';
import { isValidDrop } from './utils/isValidDrop';
import {
  Button,
  IconButton,
  TooltipProvider,
} from './components/ui';
import { panelComponents, tabComponents, WorkspaceTab } from './components/panels/PanelComponents';
import { useTheme } from './contexts/ThemeContext';
import { WorkspaceProvider } from './contexts/WorkspaceContext';
import type { WorkspaceState } from './contexts/WorkspaceContext';
import { useAnalytics } from './analytics/runtime';
import {
  setDockviewApi,
  addDefaultPanels,
  getLayoutMode,
  restoreLayout,
  resetLayout,
  saveLayout,
  openPanel,
  type WorkspacePanelId,
} from './stores/layoutStore';
import { useRenderOrchestrator } from './hooks/useRenderOrchestrator';
import { useAiAgent } from './hooks/useAiAgent';
import { useHistory } from './hooks/useHistory';
import { useMobileLayout } from './hooks/useMobileLayout';
import { getPlatform, eventBus, type ExportFormat } from './platform';
import { isExportValidationError } from './services/exportErrors';
import {
  notifyDesktopMcpRenderStarted,
  notifyDesktopMcpRenderSettled,
  syncDesktopMcpConfig,
  syncDesktopMcpWindowContext,
} from './services/desktopMcp';
import { exportModelWithContext } from './services/exportService';
import { getPreviewSceneStyle } from './services/previewSceneConfig';
import { isShareEnabled } from './services/shareService';
import { useSettings, loadSettings } from './stores/settingsStore';
import { getApiKey, getOpenAiCompatibleConfig } from './stores/apiKeyStore';
import {
  selectActiveRender,
  selectActiveTab,
  selectActiveTabId,
  selectShowWelcome,
  selectTabs,
} from './stores/workspaceSelectors';
import { useWorkspaceStore, getWorkspaceState } from './stores/workspaceStore';
import { getProjectStore, useProjectStore, getRenderTargetContent } from './stores/projectStore';
import { requestRender } from './stores/renderRequestStore';
import {
  createSourceHash,
  getRenderArtifactState,
  useRenderArtifactStore,
} from './stores/renderArtifactStore';
import {
  createWorkspaceTab,
  DEFAULT_OPENSCAD_CODE,
  DEFAULT_TAB_NAME,
} from './stores/workspaceFactories';
import {
  captureProjectDocument,
  flushProjectRecovery,
  getProjectEpoch,
  hasUnsavedProject,
  importProjectSource,
  replaceProjectDocument,
  saveCurrentProject,
  useProjectSession,
} from './services/projectLifecycle';
import { pickProjectArchive } from './platform/projectFile';
import { isValidProjectPath } from './stores/projectDocument';
import { findEmptyFolders } from './utils/workspaceFolder';
import { captureCurrentPreview, MAIN_PREVIEW_VIEWER_ID } from './utils/capturePreview';
import { notifyError, notifySuccess } from './utils/notifications';
import {
  createProjectDocument,
  decodeProjectArchive,
  exportProjectSources,
  PROJECT_EXTENSION,
} from './utils/projectZip';
import { resolveFolderImport } from './utils/folderImport';
import { useShareEntry } from './hooks/useShareEntry';
import { TbSettings, TbDownload, TbShare3 } from 'react-icons/tb';
import { Toaster } from 'sonner';
import type { WorkspaceTab as WorkspaceDocumentTab } from './stores/workspaceTypes';
import {
  OPENSCAD_PROJECT_FILE_EXTENSIONS,
  isOpenScadProjectFilePath,
} from '../../../packages/shared/src/openscadProjectFiles';

const OPENSCAD_FILE_FILTERS = [
  { name: 'OpenSCAD Files', extensions: [...OPENSCAD_PROJECT_FILE_EXTENSIONS] },
];
/** Prompt the user to pick a folder and return its project files, or null if cancelled. */
function pickFolder(): Promise<{
  files: Record<string, string>;
  renderTargetPath: string;
  name?: string;
} | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.onchange = async () => {
      try {
        const fileList = input.files;
        if (!fileList || fileList.length === 0) {
          resolve(null);
          return;
        }

        const files: Record<string, string> = {};
        let workspaceName: string | null = null;
        for (const file of Array.from(fileList)) {
          // webkitRelativePath gives "folderName/path/to/file.scad"
          const relativePath = file.webkitRelativePath;
          if (!isOpenScadProjectFilePath(relativePath)) continue;
          // Strip the top-level folder name
          const parts = relativePath.split('/');
          workspaceName ??= parts[0] || null;
          const pathWithoutRoot = parts.slice(1).join('/');
          if (pathWithoutRoot) {
            files[pathWithoutRoot] = await file.text();
          }
        }

        const result = resolveFolderImport(files, { workspaceName });
        if (!result) throw new Error('The folder has no renderable .scad files.');
        resolve({ ...result, name: workspaceName ?? undefined });
      } catch (error) {
        reject(error);
      }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function isIgnorableError(reason: unknown): boolean {
  // Raw DOM Events (e.g. from img.onerror = reject) carry no meaningful error
  // message and should not be forwarded to Sentry.
  if (typeof Event !== 'undefined' && reason instanceof Event) {
    return true;
  }

  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : typeof reason === 'object' &&
            reason !== null &&
            'message' in reason &&
            typeof (reason as { message?: unknown }).message === 'string'
          ? (reason as { message: string }).message
          : '';

  const normalized = message.trim().toLowerCase();
  return (
    normalized === 'canceled' ||
    normalized === 'cancelled' ||
    normalized === 'render cancelled' ||
    normalized === 'render canceled' ||
    normalized.includes('aborterror') ||
    normalized.includes('aborted') ||
    // drei/three.js asset loader errors (e.g. HDR environment map fetch failures)
    // are handled locally by EnvironmentWithFallback and should not surface as toasts.
    normalized.startsWith('could not load ')
  );
}

function revokeBlobUrl(url: string | null | undefined) {
  if (!url || !url.startsWith('blob:')) {
    return;
  }

  URL.revokeObjectURL(url);
}

/**
 * Returns a path that does not conflict with any path in `existing`.
 * Appends _1, _2, … to the filename stem until a free slot is found.
 */
function resolvePathConflict(candidatePath: string, existing: Set<string>): string {
  if (!existing.has(candidatePath)) return candidatePath;
  const lastSlash = candidatePath.lastIndexOf('/');
  const lastDot = candidatePath.lastIndexOf('.');
  const hasExt = lastDot > lastSlash + 1;
  const stem = hasExt ? candidatePath.slice(0, lastDot) : candidatePath;
  const ext = hasExt ? candidatePath.slice(lastDot) : '';
  let i = 1;
  while (existing.has(`${stem}_${i}${ext}`)) i++;
  return `${stem}_${i}${ext}`;
}

function App() {
  const { isMobile } = useMobileLayout();
  const tabs = useWorkspaceStore(selectTabs);
  const activeTabId = useWorkspaceStore(selectActiveTabId) ?? '';
  const showWelcome = useWorkspaceStore(selectShowWelcome);
  const activeTab = useWorkspaceStore(selectActiveTab) ?? tabs[0];
  const activeRender = useWorkspaceStore(selectActiveRender) ?? activeTab?.render;
  // The render target tab holds the preview — use its render state regardless of
  // which tab is currently active in the editor.
  const renderTargetPath = useProjectStore((s) => s.renderTargetPath);
  const projectRoot = useProjectStore((s) => s.projectRoot);
  const renderTargetTab = tabs.find((t) => t.projectPath === renderTargetPath);
  const renderTargetRender = renderTargetTab?.render ?? activeRender;
  const activeRenderArtifact = useRenderArtifactStore((state) =>
    renderTargetPath ? (state.artifactsByTarget[renderTargetPath] ?? null) : null
  );
  const createTab = useWorkspaceStore((state) => state.createTab);
  const setActiveTab = useWorkspaceStore((state) => state.setActiveTab);
  const markTabSaved = useWorkspaceStore((state) => state.markTabSaved);
  const renameTab = useWorkspaceStore((state) => state.renameTab);
  const closeTabLocal = useWorkspaceStore((state) => state.closeTabLocal);
  const reorderWorkspaceTabs = useWorkspaceStore((state) => state.reorderTabs);
  const beginTabRender = useWorkspaceStore((state) => state.beginTabRender);
  const commitTabRenderResult = useWorkspaceStore((state) => state.commitTabRenderResult);
  const commitTabRenderError = useWorkspaceStore((state) => state.commitTabRenderError);

  if (!activeTab) {
    throw new Error('Workspace store must always provide an active tab');
  }

  const activeTabRef = useRef<WorkspaceDocumentTab>(activeTab);
  const tabsRef = useRef<WorkspaceDocumentTab[]>(tabs);

  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [isProjectLoading, setIsProjectLoading] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsSection | undefined>(
    undefined
  );
  const [settings] = useSettings();
  const { theme } = useTheme();
  const previewSceneStyle = useMemo(() => getPreviewSceneStyle(theme), [theme]);
  const { capabilities } = getPlatform();
  const { undo, redo } = useHistory();
  const initialShareContext = useMemo(
    () => (typeof window === 'undefined' ? null : (window.__SHARE_CONTEXT ?? null)),
    []
  );
  const projectName = useProjectSession((state) => state.name);
  const projectDirty = useProjectSession((state) => state.revision !== state.savedRevision);
  const replacementDialogRef = useRef<HTMLDialogElement>(null);
  const replacementRef = useRef<((proceed: boolean) => void) | null>(null);
  const [confirmingReplacement, setConfirmingReplacement] = useState(false);
  const [isSavingReplacement, setIsSavingReplacement] = useState(false);

  const saveProject = useCallback(async (saveAs = false) => {
    try {
      const saved = await saveCurrentProject(saveAs);
      if (saved) notifySuccess('Project saved', { toastId: 'save-project-success' });
      return saved;
    } catch (error) {
      notifyError({
        operation: 'save-project',
        error,
        fallbackMessage: 'Could not save the project',
      });
      return false;
    }
  }, []);

  const confirmProjectReplacement = useCallback(() => {
    if (!hasUnsavedProject()) return Promise.resolve(true);
    if (replacementRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      replacementRef.current = resolve;
      setConfirmingReplacement(true);
    });
  }, []);

  useEffect(() => {
    if (confirmingReplacement) replacementDialogRef.current?.showModal();
  }, [confirmingReplacement]);

  const finishProjectReplacement = (proceed: boolean) => {
    replacementRef.current?.(proceed);
    replacementRef.current = null;
    replacementDialogRef.current?.close();
    setConfirmingReplacement(false);
  };

  useEffect(() => {
    if (!capabilities.hasFileSystem) return;

    let disposed = false;
    void syncDesktopMcpConfig({
      enabled: settings.mcp.enabled,
      port: settings.mcp.port,
    }).catch((error) => {
      if (!disposed) {
        console.error('[App] Failed to sync MCP config:', error);
      }
    });

    return () => {
      disposed = true;
    };
  }, [capabilities.hasFileSystem, settings.mcp.enabled, settings.mcp.port]);

  const renderTargetContent = useProjectStore((s) =>
    s.renderTargetPath ? (s.files[s.renderTargetPath]?.content ?? '') : ''
  );
  const contentVersion = useProjectStore((s) => s.contentVersion);

  const {
    previewKind,
    diagnostics,
    isRendering,
    error,
    ready,
    manualRender,
    renderCode: renderCodeDirect,
  } = useRenderOrchestrator({
    source: renderTargetContent,
    contentVersion,
    suppressInitialRender: Boolean(initialShareContext),
    workingDir: projectRoot,
    autoRenderOnIdle: settings.editor.autoRenderOnIdle,
    autoRenderDelayMs: settings.editor.autoRenderDelayMs,
    library: settings.library,
    createRenderOwner: () => {
      // Always render into the render target tab, not the active editor tab
      const rtPath = getProjectStore().getState().renderTargetPath;
      const rtTab = rtPath ? getWorkspaceState().tabs.find((t) => t.projectPath === rtPath) : null;
      const tabId = rtTab?.id ?? activeTabRef.current?.id;
      if (!tabId) {
        return null;
      }

      const tab = rtTab ?? activeTabRef.current;
      const requestId = beginTabRender(tabId, {
        preferredDimension: tab?.render.dimensionMode,
      });
      const targetPath = rtPath ?? tab?.projectPath ?? activeTabRef.current.projectPath;
      const currentProjectRoot = getProjectStore().getState().projectRoot;

      getRenderArtifactState().setActiveRenderTarget(targetPath, currentProjectRoot);
      notifyDesktopMcpRenderStarted({
        renderTargetPath: targetPath,
        requestId,
      });

      return {
        tabId,
        requestId,
      };
    },
    onRenderSettled: ({ owner, code, snapshot }) => {
      const settledRenderTargetPath =
        getProjectStore().getState().renderTargetPath ??
        (owner
          ? (getWorkspaceState().tabs.find((tab) => tab.id === owner.tabId)?.projectPath ?? null)
          : null);
      if (owner && settledRenderTargetPath) {
        getRenderArtifactState().publishSettledArtifact({
          requestId: owner.requestId,
          renderTargetPath: settledRenderTargetPath,
          workspaceRoot: getProjectStore().getState().projectRoot,
          sourceHash: createSourceHash(code),
          previewKind: snapshot.previewKind,
          previewSrc: snapshot.previewSrc,
          diagnostics: snapshot.diagnostics,
          error: snapshot.error,
          dimensionMode: snapshot.dimensionMode,
          sceneStyle: previewSceneStyle,
          useModelColors: settings.viewer.showModelColors,
          createdAt: Date.now(),
        });
      }
      notifyDesktopMcpRenderSettled(owner?.requestId ?? null);

      if (!owner) {
        return;
      }

      const currentTab = getWorkspaceState().tabs.find((tab) => tab.id === owner.tabId);
      const previousPreviewSrc = currentTab?.render.previewSrc ?? '';

      if (snapshot.error) {
        commitTabRenderError(owner.tabId, {
          requestId: owner.requestId,
          error: snapshot.error,
          diagnostics: snapshot.diagnostics,
          lastRenderedContent: code,
        });
        return;
      }

      if (previousPreviewSrc && previousPreviewSrc !== snapshot.previewSrc) {
        revokeBlobUrl(previousPreviewSrc);
      }

      commitTabRenderResult(owner.tabId, {
        requestId: owner.requestId,
        previewSrc: snapshot.previewSrc,
        previewKind: snapshot.previewKind,
        diagnostics: snapshot.diagnostics,
        dimensionMode: snapshot.dimensionMode,
        lastRenderedContent: code,
      });
    },
  });
  const activePreviewSrc = activeRenderArtifact?.previewSrc ?? renderTargetRender?.previewSrc ?? '';
  const activePreviewKind =
    activeRenderArtifact?.previewKind ?? renderTargetRender?.previewKind ?? previewKind;
  const activeDiagnostics =
    activeRenderArtifact?.diagnostics ?? renderTargetRender?.diagnostics ?? diagnostics;
  const activeError = activeRenderArtifact?.error ?? renderTargetRender?.error ?? error;

  const handleOpenFallbackEditor = useCallback(() => {
    window.history.replaceState({}, document.title, '/');

    if (!renderTargetRender?.lastRenderedContent && ready) {
      requestRender('initial', { immediate: true });
    }
  }, [renderTargetRender?.lastRenderedContent, ready]);

  useEffect(() => {
    getRenderArtifactState().setActiveRenderTarget(renderTargetPath ?? null, projectRoot);
  }, [projectRoot, renderTargetPath]);

  const handleOpenSharedDocument = useCallback(
    async (share: {
      title: string;
      code: string;
      files?: Record<string, string>;
      renderTarget?: string;
    }) => {
      if (!(await confirmProjectReplacement())) return null;
      const target = share.files && share.renderTarget ? share.renderTarget : DEFAULT_TAB_NAME;
      const document = createProjectDocument(share.files ?? { [target]: share.code }, target);
      replaceProjectDocument(document, {
        name: `${share.title}.${PROJECT_EXTENSION}`,
        dirty: true,
      });
      return document.activeTabId;
    },
    [confirmProjectReplacement]
  );

  const handleRenderSharedDocument = useCallback(
    ({ code }: { tabId: string; code: string }) => {
      // projectStore is already populated by handleOpenSharedDocument — just render.
      // Returns RenderSnapshot for the share entry loading flow.
      return renderCodeDirect(code, 'file_open');
    },
    [renderCodeDirect]
  );

  const {
    origin: shareOrigin,
    error: shareLoadError,
    phase: sharePhase,
    shouldBlockUi: shouldBlockShareUi,
    shouldShowError: shouldShowShareError,
    isActive: isShareEntry,
    retry: retryShareLoad,
    skip: skipShareEntry,
    dismissBanner: dismissShareBanner,
    markVisualReady: markSharePreviewReady,
    isBannerDismissed: isShareBannerDismissed,
  } = useShareEntry({
    renderReady: ready,
    openSharedDocument: handleOpenSharedDocument,
    renderSharedDocument: handleRenderSharedDocument,
    openFallbackEditor: handleOpenFallbackEditor,
  });

  const handleUndo = useCallback(async () => {
    const checkpoint = await undo();
    if (checkpoint) {
      const store = getProjectStore().getState();
      const projectPath = checkpoint.projectPath ?? activeTab.projectPath;
      if (!store.files[projectPath]) return;
      store.updateFileContent(projectPath, checkpoint.code);
      store.setCustomizerBase(projectPath, checkpoint.code);
      requestRender('history_restore', { immediate: true });
    }
  }, [activeTab.projectPath, undo]);

  const handleRedo = useCallback(async () => {
    const checkpoint = await redo();
    if (checkpoint) {
      const store = getProjectStore().getState();
      const projectPath = checkpoint.projectPath ?? activeTab.projectPath;
      if (!store.files[projectPath]) return;
      store.updateFileContent(projectPath, checkpoint.code);
      store.setCustomizerBase(projectPath, checkpoint.code);
      requestRender('history_restore', { immediate: true });
    }
  }, [activeTab.projectPath, redo]);

  const aiPromptPanelRef = useRef<AiPromptPanelRef>(null);
  const analytics = useAnalytics();

  // AI Agent state
  const {
    isStreaming,
    streamingResponse,
    proposedDiff,
    error: aiError,
    errorObject: aiErrorObject,
    isApplyingDiff,
    messages,
    draft,
    attachments,
    draftErrors,
    draftVisionBlockMessage,
    draftVisionWarningMessage,
    canSubmitDraft,
    isProcessingAttachments,
    currentToolCalls,
    currentProvider,
    currentModel,
    currentModelVisionSupport,
    lastContextUsage,
    availableProviders,
    submitDraft,
    setDraftText,
    addDraftFiles,
    removeDraftAttachment,
    addDraftComment,
    removeDraftComment,
    cancelStream,
    acceptDiff,
    rejectDiff,
    clearError: clearAiError,
    newConversation,
    selectConversation,
    conversationList,
    currentConversationId,
    interrupted,
    setCurrentModel,
    handleRestoreCheckpoint,
    updateCapturePreview,
    update3dPreviewUrl,
    updatePreviewSceneStyle,
    updateUseModelColors,
    loadModelAndProviders,
  } = useAiAgent({ persistProject: true });

  // Tab management functions
  const createNewTab = useCallback(
    (filePath?: string | null, content?: string, name?: string): string => {
      const projectPath = name ?? DEFAULT_TAB_NAME;
      const defaultContent = DEFAULT_OPENSCAD_CODE;

      // Ensure the file exists in projectStore
      const store = getProjectStore().getState();
      if (!store.files[projectPath]) {
        store.addFile(projectPath, content ?? defaultContent);
      }

      const newId = createTab({
        filePath: filePath || null,
        name,
        projectPath,
      });
      return newId;
    },
    [createTab]
  );

  const switchingRef = useRef(false);
  const [editorFocusRequestKey, setEditorFocusRequestKey] = useState(0);

  const focusEditorPanel = useCallback(() => {
    openPanel('editor');
    setEditorFocusRequestKey((current) => current + 1);
  }, []);

  const switchTab = useCallback(
    async (id: string) => {
      if (id === activeTabId || switchingRef.current) return;
      switchingRef.current = true;

      setActiveTab(id);
      // Editor handles model switching via multi-model; no need to updateSource.
      // source only tracks the render target content for the render pipeline.

      switchingRef.current = false;
    },
    [activeTabId, setActiveTab]
  );

  const closeTab = useCallback(
    (id: string) => {
      const tab = tabs.find((candidate) => candidate.id === id);
      if (!tab) return;
      const project = getProjectStore().getState();
      if (tabs.length === 1) {
        const nextPath = [project.renderTargetPath, ...Object.keys(project.files)].find(
          (path) => path && path !== tab.projectPath
        );
        if (!nextPath) return;
        createNewTab(
          project.projectRoot ? `${project.projectRoot}/${nextPath}` : null,
          undefined,
          nextPath
        );
      }
      revokeBlobUrl(tab.render.previewSrc);
      closeTabLocal(id);
      analytics.track('tab closed', {
        had_unsaved_changes: Boolean(project.files[tab.projectPath]?.isDirty),
      });
    },
    [analytics, closeTabLocal, createNewTab, tabs]
  );

  const reorderTabs = useCallback(
    (newTabs: WorkspaceDocumentTab[]) => {
      reorderWorkspaceTabs(newTabs.map((tab) => tab.id));
    },
    [reorderWorkspaceTabs]
  );

  // File tree handlers
  const handleFileTreeDoubleClick = useCallback(
    (filePath: string) => {
      focusEditorPanel();

      // Find existing tab for this file (by projectPath)
      const existingTab = tabs.find((t) => t.projectPath === filePath);
      if (existingTab) {
        switchTab(existingTab.id);
        return;
      }

      // Open the file in a new tab — content lives in projectStore
      const store = getProjectStore().getState();
      const projectFile = store.files[filePath];
      if (projectFile) {
        // Resolve absolute disk path so Cmd+S can save without a dialog
        const absolutePath = store.projectRoot ? `${store.projectRoot}/${filePath}` : null;
        createNewTab(absolutePath, undefined, filePath);
      }
    },
    [tabs, switchTab, createNewTab, focusEditorPanel]
  );

  // Editor onChange: single write to projectStore. The render pipeline reacts
  // automatically via the source prop (render target content) and contentVersion.
  const handleEditorChange = useCallback((content: string) => {
    const projectPath = activeTabRef.current.projectPath;
    getProjectStore().getState().updateFileContent(projectPath, content);
  }, []);

  const handleCreateFile = useCallback(
    async (parentDir: string): Promise<string> => {
      let baseName = 'new_file.scad';
      const store = getProjectStore().getState();
      const prefix = parentDir ? `${parentDir}/` : '';

      // Find a unique name
      let counter = 1;
      let path = `${prefix}${baseName}`;
      while (path in store.files) {
        baseName = `new_file_${counter}.scad`;
        path = `${prefix}${baseName}`;
        counter++;
      }

      const content = '';
      store.addFile(path, content, { isVirtual: store.projectRoot === null });

      // Write to disk on desktop
      if (store.projectRoot) {
        const platform = getPlatform();
        const absolutePath = `${store.projectRoot}/${path}`;
        await platform.writeTextFile(absolutePath, content);
        // Mark as saved since we just wrote it
        store.markFileSaved(path, content);
      }

      // Open in a new tab
      const absolutePath = store.projectRoot ? `${store.projectRoot}/${path}` : null;
      createNewTab(absolutePath, content, path);
      analytics.track('file created', { in_subfolder: parentDir !== '' });

      return path;
    },
    [analytics, createNewTab]
  );

  const handleCreateFolder = useCallback(
    async (parentDir: string, folderName: string): Promise<void> => {
      const store = getProjectStore().getState();
      const folderPath = parentDir ? `${parentDir}/${folderName}` : folderName;
      if (store.projectRoot) {
        await getPlatform().createDirectory(`${store.projectRoot}/${folderPath}`);
      }
      store.addFolder(folderPath);
      analytics.track('folder created', { in_subfolder: parentDir !== '' });
    },
    [analytics]
  );

  const handleRenameFile = useCallback(
    async (oldPath: string, newName: string) => {
      const store = getProjectStore().getState();
      const parentDir = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/')) : '';
      const newPath = parentDir ? `${parentDir}/${newName}` : newName;

      if (newPath === oldPath) return;
      if (newName.includes('/') || !isValidProjectPath(newPath)) {
        notifyError({ operation: 'rename-file', fallbackMessage: 'Choose a valid filename' });
        return;
      }
      if (newPath in store.files) return; // Name already taken

      store.renameFile(oldPath, newPath);

      // Rename on disk
      if (store.projectRoot) {
        const platform = getPlatform();
        await platform.renameFile(
          `${store.projectRoot}/${oldPath}`,
          `${store.projectRoot}/${newPath}`
        );
      }

      // Update any open tab that references this file
      const tab = tabs.find((t) => t.projectPath === oldPath);
      if (tab) {
        const absolutePath = store.projectRoot ? `${store.projectRoot}/${newPath}` : null;
        markTabSaved(tab.id, { filePath: absolutePath, name: newName });
        renameTab(tab.id, newName, newPath);
      }
      analytics.track('file renamed');
    },
    [analytics, tabs, markTabSaved, renameTab]
  );

  const reconcileProjectTabs = useCallback(() => {
    const project = getProjectStore().getState();
    if (!Object.keys(project.files).length) project.resetToUntitledProject();
    const current = getProjectStore().getState();
    const workspace = getWorkspaceState();
    const tabs = workspace.tabs.filter((tab) => {
      if (current.files[tab.projectPath]) return true;
      revokeBlobUrl(tab.render.previewSrc);
      return false;
    });
    if (tabs.length === workspace.tabs.length) return;
    if (!tabs.length) {
      const path = current.renderTargetPath ?? Object.keys(current.files)[0];
      tabs.push(
        createWorkspaceTab({
          projectPath: path,
          name: path,
          filePath: current.projectRoot ? `${current.projectRoot}/${path}` : null,
        })
      );
    }
    workspace.hydrateWorkspace({
      tabs,
      activeTabId: tabs.find((tab) => tab.id === workspace.activeTabId)?.id ?? tabs[0].id,
      showWelcome: false,
    });
  }, []);

  const handleDeleteFile = useCallback(
    async (filePath: string) => {
      const platform = getPlatform();
      const fileName = filePath.split('/').pop() || filePath;

      const confirmed = await platform.confirm(`Are you sure you want to delete "${fileName}"?`, {
        title: 'Delete File',
        kind: 'warning',
        okLabel: 'Delete',
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;

      const store = getProjectStore().getState();

      // Delete from disk first
      if (store.projectRoot) {
        await platform.deleteFile(`${store.projectRoot}/${filePath}`);
      }

      store.removeFile(filePath);
      reconcileProjectTabs();
      analytics.track('file deleted', {
        had_open_tab: tabs.some((tab) => tab.projectPath === filePath),
      });
    },
    [analytics, reconcileProjectTabs, tabs]
  );

  const handleDeleteFolder = useCallback(
    async (folderPath: string) => {
      const platform = getPlatform();
      const store = getProjectStore().getState();
      const prefix = folderPath + '/';
      const affected = Object.keys(store.files).filter((p) => p.startsWith(prefix));
      const folderName = folderPath.split('/').pop() || folderPath;

      const message =
        affected.length > 0
          ? `Delete "${folderName}" and its ${affected.length} file${affected.length === 1 ? '' : 's'}?`
          : `Delete empty folder "${folderName}"?`;

      const confirmed = await platform.confirm(message, {
        title: 'Delete Folder',
        kind: 'warning',
        okLabel: 'Delete',
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;

      // Disk delete first (atomic recursive remove)
      if (store.projectRoot) {
        try {
          await platform.removeDirectory(`${store.projectRoot}/${folderPath}`);
        } catch (error) {
          notifyError({ operation: 'delete-folder', error });
          return;
        }
      }

      store.removeFolder(folderPath);
      reconcileProjectTabs();
      analytics.track('folder deleted', { file_count: affected.length });
    },
    [analytics, reconcileProjectTabs]
  );

  const handleSetRenderTarget = useCallback(
    (filePath: string) => {
      getProjectStore().getState().setRenderTarget(filePath);
      analytics.track('render target changed');
    },
    [analytics]
  );

  const handleMoveItem = useCallback(
    async (sourcePath: string, destFolderPath: string, isFolder: boolean) => {
      const store = getProjectStore().getState();
      if (!isValidDrop(sourcePath, isFolder, destFolderPath)) return;
      try {
        const platform = getPlatform();
        if (isFolder) {
          const folderName = sourcePath.split('/').pop()!;
          const newFolderPath = destFolderPath ? `${destFolderPath}/${folderName}` : folderName;
          if (store.projectRoot) {
            const affected = Object.keys(store.files).filter(
              (p) => p.startsWith(sourcePath + '/') || p === sourcePath
            );
            // Ensure destination parent directories exist before moving
            const destDirs = new Set(
              affected
                .map((p) => {
                  const newRel = newFolderPath + p.slice(sourcePath.length);
                  const parent = newRel.includes('/')
                    ? newRel.substring(0, newRel.lastIndexOf('/'))
                    : '';
                  return parent ? `${store.projectRoot}/${parent}` : null;
                })
                .filter((d): d is string => d !== null)
            );
            for (const dir of destDirs) {
              await platform.createDirectory(dir);
            }
            for (const oldRel of affected) {
              const newRel = newFolderPath + oldRel.slice(sourcePath.length);
              await platform.renameFile(
                `${store.projectRoot}/${oldRel}`,
                `${store.projectRoot}/${newRel}`
              );
            }
          }
          store.moveFolder(sourcePath, newFolderPath);
          // Update any open tabs whose paths were under the moved folder
          for (const tab of tabs) {
            if (!tab.projectPath) continue;
            if (tab.projectPath.startsWith(sourcePath + '/') || tab.projectPath === sourcePath) {
              const newRel = newFolderPath + tab.projectPath.slice(sourcePath.length);
              const absPath = store.projectRoot ? `${store.projectRoot}/${newRel}` : null;
              markTabSaved(tab.id, { filePath: absPath, name: newRel.split('/').pop()! });
              renameTab(tab.id, newRel.split('/').pop()!, newRel);
            }
          }
        } else {
          const fileName = sourcePath.split('/').pop()!;
          const rawDest = destFolderPath ? `${destFolderPath}/${fileName}` : fileName;
          const existingPaths = new Set(Object.keys(store.files));
          existingPaths.delete(sourcePath);
          const newPath = resolvePathConflict(rawDest, existingPaths);
          if (store.projectRoot) {
            const parentDir = newPath.includes('/')
              ? newPath.substring(0, newPath.lastIndexOf('/'))
              : '';
            if (parentDir) await platform.createDirectory(`${store.projectRoot}/${parentDir}`);
            await platform.renameFile(
              `${store.projectRoot}/${sourcePath}`,
              `${store.projectRoot}/${newPath}`
            );
          }
          store.renameFile(sourcePath, newPath);
          const tab = tabs.find((t) => t.projectPath === sourcePath);
          if (tab) {
            const absPath = store.projectRoot ? `${store.projectRoot}/${newPath}` : null;
            markTabSaved(tab.id, { filePath: absPath, name: newPath.split('/').pop()! });
            renameTab(tab.id, newPath.split('/').pop()!, newPath);
          }
        }
        analytics.track('item moved', { kind: isFolder ? 'folder' : 'file' });
      } catch (err) {
        notifyError({ operation: 'Move failed', error: err });
      }
    },
    [analytics, tabs, markTabSaved, renameTab]
  );

  const handleAddExternalFiles = useCallback(
    async (files: Record<string, string>, targetFolderPath: string) => {
      const store = getProjectStore().getState();
      const existing = new Set(Object.keys(store.files));
      try {
        const platform = getPlatform();
        for (const [relName, content] of Object.entries(files)) {
          const rawPath = targetFolderPath ? `${targetFolderPath}/${relName}` : relName;
          const finalPath = resolvePathConflict(rawPath, existing);
          existing.add(finalPath);
          store.addFile(finalPath, content, { isVirtual: store.projectRoot === null });
          if (store.projectRoot) {
            const parentDir = finalPath.includes('/')
              ? finalPath.substring(0, finalPath.lastIndexOf('/'))
              : '';
            if (parentDir) await platform.createDirectory(`${store.projectRoot}/${parentDir}`);
            await platform.writeTextFile(`${store.projectRoot}/${finalPath}`, content);
            store.markFileSaved(finalPath, content);
          }
        }
      } catch (err) {
        notifyError({ operation: 'Add external files', error: err });
      }
    },
    []
  );

  // Note: Tree-sitter formatter is initialized in main.tsx for optimal performance

  // Keep refs in sync with state
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    update3dPreviewUrl(activePreviewKind === 'mesh' && activePreviewSrc ? activePreviewSrc : null);
  }, [activePreviewKind, activePreviewSrc, update3dPreviewUrl]);
  useEffect(() => {
    updateCapturePreview(() =>
      captureCurrentPreview({
        viewerId: MAIN_PREVIEW_VIEWER_ID,
        svgSourceUrl: activePreviewKind === 'svg' ? activePreviewSrc : null,
        targetWidth: 1200,
        targetHeight: 630,
      })
    );
    return () => updateCapturePreview(null);
  }, [activePreviewKind, activePreviewSrc, updateCapturePreview]);

  useEffect(() => {
    updatePreviewSceneStyle(previewSceneStyle);
  }, [previewSceneStyle, updatePreviewSceneStyle]);

  useEffect(() => {
    updateUseModelColors(settings.viewer.showModelColors);
  }, [settings.viewer.showModelColors, updateUseModelColors]);

  // Tab switches no longer trigger renders — the render pipeline only renders
  // the pinned render target. Editing any file that the render target includes
  // will trigger a re-render via the project store dependency chain.

  // Source-to-tab and project store sync is handled by handleEditorChange.
  // No separate sync effects needed.

  const handleOpenCustomizerAiRefine = useCallback(() => {
    openPanel('ai-chat');
    window.setTimeout(() => {
      aiPromptPanelRef.current?.focusPrompt();
    }, 0);
  }, []);

  const hasCurrentModelApiKey =
    currentProvider === 'openai-compatible'
      ? Boolean(getOpenAiCompatibleConfig().baseUrl && currentModel.trim())
      : Boolean(getApiKey(currentProvider));
  const canAttachViewerAnnotation = !isStreaming && !isProcessingAttachments;

  const attachViewerAnnotationFile = useCallback<WorkspaceState['attachViewerAnnotationFile']>(
    async (file) => {
      openPanel('ai-chat');

      if (!hasCurrentModelApiKey) {
        setSettingsInitialTab('ai');
        setShowSettingsDialog(true);
        return { status: 'missing-api-key' };
      }

      if (!canAttachViewerAnnotation) {
        return { status: 'busy' };
      }

      const result = await addDraftFiles([file], 'viewer_annotation');
      if (!result || result.readyCount < 1) {
        return {
          status: 'failed',
          errors: result?.errors ?? ['Failed to add the annotation image.'],
        };
      }

      window.setTimeout(() => {
        aiPromptPanelRef.current?.focusPrompt();
      }, 0);

      return { status: 'attached' };
    },
    [addDraftFiles, canAttachViewerAnnotation, hasCurrentModelApiKey]
  );

  const attachViewerComment = useCallback<WorkspaceState['attachViewerComment']>(
    async (comment) => {
      openPanel('ai-chat');
      if (!hasCurrentModelApiKey) {
        setSettingsInitialTab('ai');
        setShowSettingsDialog(true);
        return { status: 'missing-api-key' };
      }
      if (!canAttachViewerAnnotation) return { status: 'busy' };

      addDraftComment(comment);
      window.setTimeout(() => aiPromptPanelRef.current?.focusPrompt(), 0);
      return { status: 'attached' };
    },
    [addDraftComment, canAttachViewerAnnotation, hasCurrentModelApiKey]
  );

  const handleOpenExportDialog = useCallback(() => {
    setShowExportDialog(true);
  }, []);

  const handleOpenShareDialog = useCallback(() => {
    if (!isShareEnabled()) {
      return;
    }
    setShowShareDialog(true);
  }, []);

  useEffect(() => {
    const unlistenFns = [
      eventBus.on('menu:file:new', async () => {
        if (!(await confirmProjectReplacement())) return;
        replaceProjectDocument(
          createProjectDocument({ [DEFAULT_TAB_NAME]: DEFAULT_OPENSCAD_CODE }, DEFAULT_TAB_NAME)
        );
        requestRender('file_open', { immediate: true });
      }),
      eventBus.on('menu:file:new_file', () => {
        void handleCreateFile('')
          .then(focusEditorPanel)
          .catch((error) =>
            notifyError({
              operation: 'new-file',
              error,
              fallbackMessage: 'Could not create the file',
            })
          );
      }),
      eventBus.on('menu:file:open', async () => {
        try {
          const platform = getPlatform();
          const selected = await platform.fileOpen(OPENSCAD_FILE_FILTERS);
          if (!selected) return;
          if (!isOpenScadProjectFilePath(selected.name) || !isValidProjectPath(selected.name))
            throw new Error('Choose a .scad or .h file with a valid filename.');
          const project = getProjectStore().getState();
          const { path, reuse } = importProjectSource(
            project.files,
            selected.name,
            selected.content,
            project.emptyFolders
          );
          const absolutePath = project.projectRoot ? `${project.projectRoot}/${path}` : null;
          if (!reuse) {
            const epoch = getProjectEpoch();
            if (absolutePath) {
              if (await platform.fileExists(absolutePath))
                throw new Error('A file with this name already exists in the workspace folder.');
              await platform.writeTextFile(absolutePath, selected.content);
            }
            if (epoch !== getProjectEpoch()) return;
            project.addFile(path, selected.content);
            if (absolutePath) project.markFileSaved(path, selected.content);
          }
          const tab = getWorkspaceState().tabs.find((candidate) => candidate.projectPath === path);
          if (tab) setActiveTab(tab.id);
          else createNewTab(absolutePath, undefined, path);
          focusEditorPanel();
          analytics.track('file opened', {
            source: 'menu_open',
            has_disk_path: Boolean(selected.path),
          });
        } catch (error) {
          notifyError({
            operation: 'open-file',
            error,
            fallbackMessage: 'Could not open the file',
          });
        }
      }),
      eventBus.on('menu:file:open_project', async () => {
        setIsProjectLoading(true);
        try {
          const selected = await pickProjectArchive();
          if (!selected) return;
          const { document, legacy } = decodeProjectArchive(selected.bytes, selected.name);
          const importing = legacy || selected.name.toLowerCase().endsWith('.zip');
          if (!(await confirmProjectReplacement())) return;
          replaceProjectDocument(document, {
            name: importing
              ? selected.name.replace(/\.zip$/i, `.${PROJECT_EXTENSION}`)
              : selected.name,
            destination: importing ? null : selected.destination,
            dirty: importing,
          });
          requestRender('file_open', { immediate: true });
        } catch (error) {
          notifyError({
            operation: 'open-project',
            error,
            fallbackMessage: 'Could not open the project',
          });
        } finally {
          setIsProjectLoading(false);
        }
      }),
      eventBus.on('menu:file:open_folder', async () => {
        setIsProjectLoading(true);
        try {
          const platform = getPlatform();
          let name: string | undefined;
          let emptyFolders: string[] = [];
          let result;
          if (platform.capabilities.hasFileSystem) {
            const folder = await platform.pickDirectory();
            if (!folder) return;
            name = folder.split(/[/\\]/).filter(Boolean).pop();
            const files = await platform.readDirectoryFiles(
              folder,
              [...OPENSCAD_PROJECT_FILE_EXTENSIONS],
              true
            );
            emptyFolders = findEmptyFolders(
              await platform.readSubdirectories(folder),
              Object.keys(files)
            );
            result = resolveFolderImport(files, { workspaceName: name });
          } else {
            result = await pickFolder();
            if (!result) return;
            name = result.name;
          }
          if (!result) throw new Error('The folder has no renderable .scad files.');
          if (!(await confirmProjectReplacement())) return;
          replaceProjectDocument(
            createProjectDocument(result.files, result.renderTargetPath, emptyFolders),
            {
              name: name ? `${name}.${PROJECT_EXTENSION}` : undefined,
              dirty: true,
            }
          );
          requestRender('file_open', { immediate: true });
        } catch (error) {
          notifyError({
            operation: 'import-folder',
            error,
            fallbackMessage: 'Could not import the folder',
          });
        } finally {
          setIsProjectLoading(false);
        }
      }),
      eventBus.on('menu:file:save', () => void saveProject()),
      eventBus.on('menu:file:save_as', () => void saveProject(true)),
      eventBus.on('menu:file:export_source', async () => {
        try {
          const workspace = getWorkspaceState();
          const tab = workspace.tabs.find(({ id }) => id === workspace.activeTabId);
          const file = tab && getProjectStore().getState().files[tab.projectPath];
          if (!tab || !file) return;
          const name = tab.projectPath.split('/').pop() ?? tab.name;
          await getPlatform().fileExport(
            new TextEncoder().encode(file.content),
            name,
            OPENSCAD_FILE_FILTERS
          );
        } catch (error) {
          notifyError({
            operation: 'export-source',
            error,
            fallbackMessage: 'Could not export the file',
          });
        }
      }),
      eventBus.on('menu:file:export_all', async () => {
        try {
          await getPlatform().fileExport(
            exportProjectSources(captureProjectDocument()),
            projectName.replace(/\.[^.]+$/, '') + '.zip',
            [{ name: 'ZIP Archive', extensions: ['zip'] }]
          );
        } catch (error) {
          notifyError({
            operation: 'export-sources',
            error,
            fallbackMessage: 'Could not export the source files',
          });
        }
      }),
      eventBus.on('menu:window:open_panel', (panelId: WorkspacePanelId) => {
        openPanel(panelId);
      }),
      eventBus.on('menu:window:reset_workspace', () => {
        resetLayout();
      }),
    ];

    unlistenFns.push(
      eventBus.on('menu:file:export', async (format: ExportFormat) => {
        try {
          const formatLabels: Record<ExportFormat, { label: string; ext: string }> = {
            stl: { label: 'STL (3D Model)', ext: 'stl' },
            obj: { label: 'OBJ (3D Model)', ext: 'obj' },
            amf: { label: 'AMF (3D Model)', ext: 'amf' },
            '3mf': { label: '3MF (3D Model)', ext: '3mf' },
            png: { label: 'PNG (Image)', ext: 'png' },
            svg: { label: 'SVG (2D Vector)', ext: 'svg' },
            dxf: { label: 'DXF (2D CAD)', ext: 'dxf' },
          };
          const formatInfo = formatLabels[format];
          const rtContent = getRenderTargetContent(getProjectStore().getState()) ?? '';
          const exportBytes = await exportModelWithContext({
            format,
            source: rtContent,
            library: loadSettings().library,
          });
          await getPlatform().fileExport(exportBytes, `export.${formatInfo.ext}`, [
            { name: formatInfo.label, extensions: [formatInfo.ext] },
          ]);
          analytics.track('file exported', {
            format,
          });
          notifySuccess('Exported successfully', { toastId: 'export-success' });
        } catch (err) {
          notifyError({
            operation: 'export-file',
            error: err,
            capture: !isExportValidationError(err),
            fallbackMessage: 'Export failed',
            toastId: 'export-error',
            logLabel: 'Export failed',
          });
        }
      })
    );

    return () => unlistenFns.forEach((unlisten) => unlisten());
  }, [
    analytics,
    confirmProjectReplacement,
    createNewTab,
    focusEditorPanel,
    handleCreateFile,
    projectName,
    saveProject,
    setActiveTab,
  ]);

  useEffect(() => {
    const platform = getPlatform();
    if (!platform.capabilities.hasFileSystem) return;
    return platform.onCloseRequested(async () => {
      if (await flushProjectRecovery()) return true;
      return platform.confirm('Workspace recovery failed. Close anyway?', {
        title: 'Workspace Recovery',
        okLabel: 'Close',
        cancelLabel: 'Cancel',
      });
    });
  }, [capabilities.hasFileSystem]);

  useEffect(() => {
    const workspaceName = projectRoot
      ? (projectRoot.split('/').filter(Boolean).pop() ?? activeTab.name)
      : projectName === `untitled.${PROJECT_EXTENSION}`
        ? 'Untitled Project'
        : projectName.replace(/\.[^.]+$/, '');
    const title = `${projectDirty ? '\u2022 ' : ''}${workspaceName} - OpenSCAD Studio`;
    getPlatform().setWindowTitle(title);

    if (capabilities.hasFileSystem) {
      void syncDesktopMcpWindowContext({
        title,
        workspaceRoot: projectRoot,
        renderTargetPath,
        showWelcome,
        mode: showWelcome ? 'welcome' : 'ready',
      }).catch((error) => {
        console.error('[App] Failed to sync MCP window context:', error);
      });
    }
  }, [
    activeTab.name,
    capabilities.hasFileSystem,
    projectDirty,
    projectName,
    projectRoot,
    renderTargetPath,
    showWelcome,
  ]);

  // Watch project directory for external file changes (desktop only)
  useEffect(() => {
    if (!projectRoot) return;
    const platform = getPlatform();
    if (!platform.capabilities.hasFileSystem) return;

    let unwatchFn: (() => void) | null = null;
    let disposed = false;

    platform
      .watchDirectory(projectRoot, (relativePath, content) => {
        const store = getProjectStore().getState();
        if (disposed || store.projectRoot !== projectRoot) return;
        if (content === null) {
          // File was deleted externally — only remove if it exists and isn't dirty
          if (relativePath in store.files && !store.files[relativePath].isDirty) {
            store.removeFile(relativePath);
            reconcileProjectTabs();
          }
          return;
        }
        // File was created or modified externally
        if (relativePath in store.files) {
          // Only update if the file isn't dirty (don't overwrite unsaved user edits)
          if (!store.files[relativePath].isDirty && store.files[relativePath].content !== content) {
            store.updateFileContent(relativePath, content);
            store.markFileSaved(relativePath, content);
          }
        } else {
          store.addFile(relativePath, content);
          store.markFileSaved(relativePath, content);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unwatchFn = fn;
      })
      .catch((error) => {
        if (!disposed) console.warn('[App] Could not watch the workspace folder', error);
      });

    return () => {
      disposed = true;
      unwatchFn?.();
    };
  }, [projectRoot, reconcileProjectTabs]);

  useEffect(() => {
    const unlisten = eventBus.on('render-requested', ({ source }) => {
      requestRender(source === 'ai' ? 'ai_edit' : 'manual', { immediate: true });
    });
    return unlisten;
  }, []);

  useEffect(() => {
    const unlisten = eventBus.on('code-updated', ({ code, source: eventSource }) => {
      const store = getProjectStore().getState();
      // AI edits and customizer changes address the render target. The editor
      // may be showing another project file.
      const projectPath =
        eventSource === 'customizer' || eventSource === 'ai'
          ? (store.renderTargetPath ?? activeTabRef.current.projectPath)
          : activeTabRef.current.projectPath;
      store.updateFileContent(projectPath, code);
      if (eventSource !== 'customizer') {
        store.setCustomizerBase(projectPath, code);
      }
      requestRender(
        eventSource === 'history'
          ? 'history_restore'
          : eventSource === 'ai'
            ? 'ai_edit'
            : 'code_update',
        { immediate: true }
      );
    });
    return unlisten;
  }, []);

  const previousSettingsDialogRef = useRef(false);
  useEffect(() => {
    if (showSettingsDialog && !previousSettingsDialogRef.current) {
      analytics.track('settings opened', {
        section: settingsInitialTab ?? 'appearance',
      });
    }
    previousSettingsDialogRef.current = showSettingsDialog;
  }, [analytics, settingsInitialTab, showSettingsDialog]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (confirmingReplacement) return;
      if (!capabilities.hasNativeMenu && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
        const key = e.key.toLowerCase();
        if (key === 'n' && !e.shiftKey) {
          e.preventDefault();
          eventBus.emit('menu:file:new');
        }
        if (key === 'o') {
          e.preventDefault();
          eventBus.emit(e.shiftKey ? 'menu:file:open_project' : 'menu:file:open');
        }
      }
      // ⌘K or Ctrl+K to focus AI prompt
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        openPanel('ai-chat');
        setTimeout(() => {
          aiPromptPanelRef.current?.focusPrompt();
        }, 0);
      }
      // ⌘, or Ctrl+, to open settings
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setShowSettingsDialog(true);
      }
      // ⌘T or Ctrl+T for new tab
      if ((e.metaKey || e.ctrlKey) && e.key === 't') {
        e.preventDefault();
        eventBus.emit('menu:file:new_file');
      }
      // ⌘W or Ctrl+W to close tab
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault();
        closeTab(activeTabId);
      }
      if (
        !capabilities.hasNativeMenu &&
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 's' &&
        !e.defaultPrevented
      ) {
        e.preventDefault();
        eventBus.emit(e.shiftKey ? 'menu:file:save_as' : 'menu:file:save');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [capabilities.hasNativeMenu, closeTab, activeTabId, confirmingReplacement]);

  useEffect(() => {
    if (aiError) {
      notifyError({
        operation: 'ai-stream',
        error: aiErrorObject ?? aiError,
        displayMessage: aiError,
        fallbackMessage: 'AI request failed',
        toastId: 'ai-stream-error',
      });
      clearAiError();
    }
  }, [aiError, aiErrorObject, clearAiError]);

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      if (isIgnorableError(event.error ?? event.message)) {
        return;
      }
      notifyError({
        operation: 'unexpected-runtime-error',
        error: event.error ?? event.message,
        fallbackMessage: 'Something went wrong in the app',
        toastId: 'unexpected-runtime-error',
        logLabel: '[App] Unhandled window error',
      });
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isIgnorableError(event.reason)) {
        return;
      }

      notifyError({
        operation: 'unexpected-runtime-error',
        error: event.reason,
        fallbackMessage: 'An unexpected error interrupted the current action',
        toastId: 'unexpected-runtime-error',
        logLabel: '[App] Unhandled promise rejection',
      });
    };

    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  const onDockviewReady = useCallback((event: DockviewReadyEvent) => {
    const { api } = event;
    const layoutMode = getLayoutMode();
    setDockviewApi(api);

    if (!restoreLayout(api, layoutMode)) {
      addDefaultPanels(api, layoutMode);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    api.onDidLayoutChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        saveLayout(layoutMode);
      }, 300);
    });
  }, []);

  const workspaceState: WorkspaceState = useMemo(
    () => ({
      source: renderTargetContent,
      updateSource: handleEditorChange,
      diagnostics: activeDiagnostics,
      onManualRender: manualRender,
      settings,
      editorFocusRequestKey,
      tabs,
      activeTabId,
      onTabClick: switchTab,
      onTabClose: closeTab,
      onNewTab: () => eventBus.emit('menu:file:new_file'),
      onReorderTabs: reorderTabs,
      onFileDoubleClick: handleFileTreeDoubleClick,
      onRenameFile: handleRenameFile,
      onDeleteFile: handleDeleteFile,
      onDeleteFolder: handleDeleteFolder,
      onSetRenderTarget: handleSetRenderTarget,
      onCreateFile: handleCreateFile,
      onCreateFolder: handleCreateFolder,
      onMoveItem: handleMoveItem,
      onAddExternalFiles: handleAddExternalFiles,
      previewSrc: activePreviewSrc,
      previewKind: activePreviewKind,
      previewCommentContext: {
        renderTargetPath:
          activeRenderArtifact?.renderTargetPath ?? renderTargetPath ?? activeTab.projectPath,
        sourceHash: activeRenderArtifact?.sourceHash,
      },
      isRendering: isRendering || isProjectLoading,
      error: activeError,
      renderReady: ready,
      onPreviewVisualReady: isShareEntry ? markSharePreviewReady : undefined,
      isStreaming,
      streamingResponse,
      proposedDiff,
      aiError,
      isApplyingDiff,
      messages,
      draft,
      attachments,
      draftErrors,
      draftVisionBlockMessage,
      draftVisionWarningMessage,
      canSubmitDraft,
      isProcessingAttachments,
      currentToolCalls,
      currentProvider,
      currentModel,
      currentModelVisionSupport,
      lastContextUsage,
      availableProviders,
      submitDraft,
      setDraftText,
      addDraftFiles,
      removeDraftAttachment,
      removeDraftComment,
      hasCurrentModelApiKey,
      canAttachViewerAnnotation,
      attachViewerAnnotationFile,
      attachViewerComment,
      cancelStream,
      acceptDiff,
      rejectDiff,
      clearAiError,
      newConversation,
      selectConversation,
      conversationList,
      currentConversationId,
      interrupted,
      setCurrentModel,
      handleRestoreCheckpoint,
      aiPromptPanelRef,
      onAcceptDiff: acceptDiff,
      onRejectDiff: rejectDiff,
      onOpenAiSettings: () => {
        setSettingsInitialTab('ai');
        setShowSettingsDialog(true);
      },
      onOpenCustomizerAiRefine: handleOpenCustomizerAiRefine,
      onOpenExportDialog: handleOpenExportDialog,
    }),
    [
      renderTargetContent,
      handleEditorChange,
      activeDiagnostics,
      manualRender,
      settings,
      editorFocusRequestKey,
      tabs,
      activeTabId,
      switchTab,
      closeTab,
      reorderTabs,
      handleFileTreeDoubleClick,
      handleRenameFile,
      handleDeleteFile,
      handleDeleteFolder,
      handleSetRenderTarget,
      handleCreateFile,
      handleCreateFolder,
      handleMoveItem,
      handleAddExternalFiles,
      activePreviewSrc,
      activePreviewKind,
      activeRenderArtifact,
      renderTargetPath,
      activeTab.projectPath,
      isRendering,
      isProjectLoading,
      activeError,
      ready,
      isShareEntry,
      markSharePreviewReady,
      isStreaming,
      streamingResponse,
      proposedDiff,
      aiError,
      isApplyingDiff,
      messages,
      draft,
      attachments,
      draftErrors,
      draftVisionBlockMessage,
      draftVisionWarningMessage,
      canSubmitDraft,
      isProcessingAttachments,
      currentToolCalls,
      currentProvider,
      currentModel,
      currentModelVisionSupport,
      lastContextUsage,
      availableProviders,
      submitDraft,
      setDraftText,
      addDraftFiles,
      removeDraftAttachment,
      removeDraftComment,
      hasCurrentModelApiKey,
      canAttachViewerAnnotation,
      attachViewerAnnotationFile,
      attachViewerComment,
      cancelStream,
      acceptDiff,
      rejectDiff,
      clearAiError,
      newConversation,
      selectConversation,
      conversationList,
      currentConversationId,
      interrupted,
      setCurrentModel,
      handleRestoreCheckpoint,
      handleOpenCustomizerAiRefine,
      handleOpenExportDialog,
    ]
  );

  const canUseShare = !capabilities.hasNativeMenu && isShareEnabled();
  const shouldShowShareBanner = Boolean(
    shareOrigin && sharePhase === 'ready' && !isShareBannerDismissed
  );

  const shareBlockingOverlay = shouldBlockShareUi ? (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center"
      data-testid="share-loading-screen"
      style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      <div
        className="flex w-full max-w-md flex-col items-center text-center rounded-2xl"
        style={{
          backgroundColor: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          gap: 'var(--space-helper-gap)',
          padding: `var(--space-dialog-padding-y) var(--space-dialog-padding-x)`,
        }}
      >
        <div
          className="h-8 w-8 animate-spin rounded-full border-2"
          style={{
            borderColor: 'var(--border-primary)',
            borderTopColor: 'var(--accent-primary)',
          }}
        />
        <div className="text-lg font-semibold">Opening shared design...</div>
        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Loading the shared model, preview, and layout.
        </div>
      </div>
    </div>
  ) : null;

  const content = shouldShowShareError ? (
    <div
      className="flex h-screen items-center justify-center"
      data-testid="share-error-screen"
      style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      <div
        className="flex w-full max-w-md flex-col rounded-2xl"
        style={{
          backgroundColor: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          gap: 'var(--space-section-gap)',
          padding: `var(--space-dialog-padding-y) var(--space-dialog-padding-x)`,
        }}
      >
        <div className="text-lg font-semibold">Couldn&apos;t open this shared design</div>
        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {shareLoadError}
        </div>
        <div
          className="flex items-center justify-end"
          style={{ gap: 'var(--space-dialog-footer-gap)' }}
        >
          <Button variant="secondary" onClick={skipShareEntry}>
            Go to Editor
          </Button>
          <Button variant="primary" onClick={retryShareLoad}>
            Retry
          </Button>
        </div>
      </div>
    </div>
  ) : (
    <div
      className="h-screen flex flex-col"
      data-testid="app-container"
      style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      <header
        className="relative flex items-center gap-1.5 shrink-0 py-1"
        style={{
          backgroundColor: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        {!capabilities.hasNativeMenu && (
          <WebMenuBar
            onExport={() => setShowExportDialog(true)}
            onShare={canUseShare ? handleOpenShareDialog : undefined}
            onSettings={() => setShowSettingsDialog(true)}
            onUndo={handleUndo}
            onRedo={handleRedo}
          />
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-1.5 px-3 py-1 shrink-0">
          {(isRendering || isProjectLoading) && (
            <div
              data-testid="render-spinner"
              className="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full"
              style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            >
              <div
                className="animate-spin h-2.5 w-2.5 border-2 rounded-full"
                style={{
                  borderColor: 'var(--border-primary)',
                  borderTopColor: 'var(--accent-primary)',
                }}
              />
              <span>Rendering</span>
            </div>
          )}

          {!isMobile && (
            <>
              <Button
                data-testid="render-button"
                variant="primary"
                onClick={manualRender}
                disabled={isRendering || !ready}
                size="sm"
                className="text-xs px-2 py-1"
              >
                Render (⌘↵)
              </Button>
            </>
          )}

          <Button
            data-testid="export-button"
            variant="secondary"
            onClick={() => setShowExportDialog(true)}
            size="sm"
            disabled={isRendering || !ready}
            className="text-xs px-2 py-1"
          >
            <span className="inline-flex items-center gap-1.5">
              <TbDownload size={14} />
              <span>Export</span>
            </span>
          </Button>
          {canUseShare && (
            <Button
              data-testid="share-button"
              variant="secondary"
              onClick={handleOpenShareDialog}
              size="sm"
              disabled={isRendering || !ready}
              className="text-xs px-2 py-1"
            >
              <span className="inline-flex items-center gap-1.5">
                <TbShare3 size={14} />
                <span>Share</span>
              </span>
            </Button>
          )}

          <div
            style={{ width: '1px', height: '16px', backgroundColor: 'var(--border-secondary)' }}
          />

          <IconButton
            data-testid="settings-button"
            onClick={() => setShowSettingsDialog(true)}
            size="sm"
            title="Settings (⌘,)"
            aria-label="Settings"
          >
            <TbSettings size={16} />
          </IconButton>
        </div>
      </header>

      {shouldShowShareBanner && shareOrigin && (
        <ShareBanner
          origin={shareOrigin}
          onShareRemix={handleOpenShareDialog}
          onDismiss={dismissShareBanner}
        />
      )}

      <div className="flex-1 overflow-hidden">
          <WorkspaceProvider value={workspaceState}>
            <DockviewReact
              components={panelComponents}
              tabComponents={tabComponents}
              defaultTabComponent={WorkspaceTab}
              onReady={onDockviewReady}
              className="dockview-theme-openscad"
              disableFloatingGroups={true}
            />
          </WorkspaceProvider>
      </div>

      <ExportDialog
        isOpen={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        source={renderTargetContent}
        workingDir={projectRoot}
        previewKind={activePreviewKind}
      />
      <ShareDialog
        isOpen={showShareDialog}
        onClose={() => setShowShareDialog(false)}
        source={renderTargetContent}
        tabName={activeTab.name}
        forkedFrom={shareOrigin?.shareId ?? null}
        capturePreview={() =>
          captureCurrentPreview({
            viewerId: MAIN_PREVIEW_VIEWER_ID,
            svgSourceUrl: activePreviewKind === 'svg' ? activePreviewSrc : null,
            targetWidth: 1200,
            targetHeight: 630,
          })
        }
        preview3dUrl={activePreviewKind === 'mesh' ? activePreviewSrc : null}
        previewKind={activePreviewKind}
        useModelColors={settings.viewer.showModelColors}
      />

      <SettingsDialog
        isOpen={showSettingsDialog}
        onClose={() => {
          setShowSettingsDialog(false);
          setSettingsInitialTab(undefined);
          loadModelAndProviders();
        }}
        initialTab={settingsInitialTab}
      />
    </div>
  );

  return (
    <TooltipProvider>
      {content}
      {shareBlockingOverlay}
      {confirmingReplacement && (
        <dialog
          ref={replacementDialogRef}
          aria-labelledby="save-before-replacing-title"
          className="w-full max-w-sm rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5 text-[var(--text-primary)] backdrop:bg-black/60"
          onCancel={(event) => {
            event.preventDefault();
            if (!isSavingReplacement) finishProjectReplacement(false);
          }}
        >
          <h2 id="save-before-replacing-title" className="font-semibold">
            Save changes to this project?
          </h2>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => finishProjectReplacement(false)}
              disabled={isSavingReplacement}
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => finishProjectReplacement(true)}
              disabled={isSavingReplacement}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              autoFocus
              disabled={isSavingReplacement}
              onClick={async () => {
                setIsSavingReplacement(true);
                const saved = await saveProject();
                setIsSavingReplacement(false);
                if (saved && !hasUnsavedProject()) finishProjectReplacement(true);
              }}
            >
              Save
            </Button>
          </div>
        </dialog>
      )}
      <Toaster
        richColors
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-primary)',
          },
        }}
      />
    </TooltipProvider>
  );
}

export default App;
