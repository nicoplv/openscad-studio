import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { getProjectStore, getProjectState } from '../stores/projectStore';
import { getWorkspaceState, workspaceStore } from '../stores/workspaceStore';
import {
  createWorkspaceTab,
  DEFAULT_OPENSCAD_CODE,
  DEFAULT_TAB_NAME,
} from '../stores/workspaceFactories';
import {
  EMPTY_CONVERSATIONS,
  projectDocumentSchema,
  type ProjectConversations,
  type ProjectDocument,
} from '../stores/projectDocument';
import type { ProjectFile } from '../stores/projectTypes';
import {
  createProjectDocument,
  encodeProjectArchive,
  PROJECT_EXTENSION,
} from '../utils/projectZip';
import { writeProjectArchive, type ProjectDestination } from '../platform/projectFile';
import { notifyError } from '../utils/notifications';
import { historyService } from '../platform/historyService';
import { loadSettings } from '../stores/settingsStore';
import { formatOpenScadCode } from '../utils/formatter';
import { isRenderableOpenScadFilePath } from '../../../../packages/shared/src/openscadProjectFiles';

interface ProjectSession {
  name: string;
  destination: ProjectDestination | null;
  revision: number;
  savedRevision: number;
  epoch: number;
}

const UNTITLED_NAME = `untitled.${PROJECT_EXTENSION}`;
const projectSession = createStore<ProjectSession>(() => ({
  name: UNTITLED_NAME,
  destination: null,
  revision: 0,
  savedRevision: 0,
  epoch: 0,
}));

interface RecoveryRecord {
  version: 1;
  document: ProjectDocument;
  name: string;
  destination: ProjectDestination | null;
  dirty: boolean;
  priority: number;
  folder?: { root: string; files: Record<string, ProjectFile> };
}

let ai = EMPTY_CONVERSATIONS;
let hydrating = false;
let saving = false;
let sequence = 0;
let committedSequence = 0;
let pending: { record: RecoveryRecord; sequence: number } | null = null;
let drain: Promise<void> | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;
let focusTime = 0;

export function useProjectSession<T>(selector: (state: ProjectSession) => T): T {
  return useStore(projectSession, selector);
}

export function getProjectEpoch() {
  return projectSession.getState().epoch;
}

export function getProjectConversations() {
  return ai;
}

export function setProjectConversations(conversations: ProjectConversations) {
  if (ai === conversations) return;
  ai = conversations;
  changed();
}

export function captureProjectDocument(): ProjectDocument {
  const project = getProjectState();
  const workspace = getWorkspaceState();
  const files = Object.fromEntries(
    Object.entries(project.files).map(([path, file]) => [path, file.content])
  );
  const tabs = workspace.tabs
    .filter(({ projectPath }) => Object.prototype.hasOwnProperty.call(files, projectPath))
    .map(({ id, name, projectPath }) => ({ id, name, projectPath }));
  if (tabs.length === 0) {
    const path = project.renderTargetPath ?? Object.keys(files)[0];
    if (path) {
      const tab = createWorkspaceTab({ name: path, projectPath: path });
      tabs.push({ id: tab.id, name: tab.name, projectPath: tab.projectPath });
    }
  }
  return {
    files,
    emptyFolders: project.emptyFolders,
    renderTargetPath: project.renderTargetPath,
    tabs,
    activeTabId: tabs.find(({ id }) => id === workspace.activeTabId)?.id ?? tabs[0]?.id ?? '',
    ai,
  };
}

export function hasUnsavedProject() {
  const { revision, savedRevision } = projectSession.getState();
  return revision !== savedRevision;
}

export function replaceProjectDocument(
  document: ProjectDocument,
  options: {
    name?: string;
    destination?: ProjectDestination | null;
    dirty?: boolean;
    recovery?: RecoveryRecord;
    starter?: boolean;
  } = {}
) {
  const { recovery } = options;
  const root = recovery?.folder?.root ?? null;
  hydrating = true;
  try {
    historyService.clear();
    const store = getProjectStore();
    store.getState().openProject(root, document.files, document.renderTargetPath);
    store.setState({
      emptyFolders: document.emptyFolders,
      ...(recovery?.folder ? { files: recovery.folder.files } : {}),
    });
    for (const tab of getWorkspaceState().tabs) {
      if (tab.render.previewSrc.startsWith('blob:')) URL.revokeObjectURL(tab.render.previewSrc);
    }
    workspaceStore.getState().hydrateWorkspace({
      tabs: document.tabs.map((tab) =>
        createWorkspaceTab({
          ...tab,
          filePath: root ? `${root}/${tab.projectPath}` : null,
        })
      ),
      activeTabId: document.activeTabId,
      showWelcome: options.starter ?? false,
    });
    ai = document.ai;
    projectSession.setState((state) => ({
      name: options.name ?? UNTITLED_NAME,
      destination: options.destination ?? null,
      revision: 0,
      savedRevision: options.dirty ? -1 : 0,
      epoch: state.epoch + 1,
    }));
  } finally {
    hydrating = false;
  }
  if (!recovery && !options.starter) queueRecovery();
}

export function initializeStarterProject() {
  replaceProjectDocument(
    createProjectDocument({ [DEFAULT_TAB_NAME]: DEFAULT_OPENSCAD_CODE }, DEFAULT_TAB_NAME),
    { starter: true }
  );
}

// Explicit desktop MCP opens attach a folder. The portable save destination
// belongs to the project being replaced, so clear it on a successful attach.
export function adoptExternalProject(name: string) {
  historyService.clear();
  ai = EMPTY_CONVERSATIONS;
  projectSession.setState((state) => ({
    name: `${name}.${PROJECT_EXTENSION}`,
    destination: null,
    revision: 0,
    savedRevision: 0,
    epoch: state.epoch + 1,
  }));
  queueRecovery();
}

export async function saveCurrentProject(saveAs = false, write = writeProjectArchive) {
  if (saving) return false;
  const { name, destination, revision, epoch } = projectSession.getState();
  const document = captureProjectDocument();
  const sourceFiles = getProjectState().files;
  const editor = loadSettings().editor;
  let writtenFiles = document.files;
  saving = true;
  try {
    const result = await write(
      async () => {
        const entries = await Promise.all(
          Object.entries(document.files).map(async ([path, content]) => {
            if (
              editor.formatOnSave &&
              sourceFiles[path].isDirty &&
              isRenderableOpenScadFilePath(path)
            ) {
              try {
                const formatted = await formatOpenScadCode(content, {
                  indentSize: editor.indentSize,
                  useTabs: editor.useTabs,
                });
                return [path, formatted] as const;
              } catch {
                // The editor buffer remains the source when the formatter is unavailable.
              }
            }
            return [path, content] as const;
          })
        );
        writtenFiles = Object.fromEntries(entries);
        return encodeProjectArchive({ ...document, files: writtenFiles });
      },
      name,
      saveAs ? null : destination
    );
    if (!result || projectSession.getState().epoch !== epoch) return false;
    projectSession.setState({ ...result, savedRevision: revision });
    const store = getProjectStore();
    if (!store.getState().projectRoot) {
      hydrating = true;
      try {
        for (const [path, content] of Object.entries(writtenFiles)) {
          const project = store.getState();
          if (content !== document.files[path] && project.files[path] === sourceFiles[path]) {
            project.updateFileContent(path, content);
            project.setCustomizerBase(path, content);
          }
          project.markFileSaved(path, content);
        }
      } finally {
        hydrating = false;
      }
    }
    queueRecovery();
    return true;
  } finally {
    saving = false;
  }
}

function openDatabase() {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openscad-studio-recovery', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspace');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Workspace recovery database is blocked.'));
    });
  }
  return dbPromise;
}

export async function restoreLastProject() {
  try {
    const db = await openDatabase();
    const record = await new Promise<RecoveryRecord | undefined>((resolve, reject) => {
      const request = db.transaction('workspace').objectStore('workspace').get('last');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (record?.version !== 1) return false;
    const document = projectDocumentSchema.parse(record.document);
    replaceProjectDocument(document, {
      recovery: record,
      name: record.name,
      destination: record.destination,
      dirty: record.dirty,
    });
    return true;
  } catch (error) {
    notifyError({
      operation: 'restore-project',
      fallbackMessage: 'Could not restore the last project',
      toastId: 'restore-project-error',
      error,
    });
    return false;
  }
}

function writeRecovery(db: IDBDatabase, record: RecoveryRecord) {
  return new Promise<boolean>((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    const store = transaction.objectStore('workspace');
    const current = store.get('last');
    let written = false;
    current.onsuccess = () => {
      if ((current.result?.priority ?? 0) > record.priority) return;
      store.put(record, 'last');
      written = true;
    };
    transaction.oncomplete = () => resolve(written);
    transaction.onabort = () => reject(transaction.error);
  });
}

function queueRecovery() {
  sequence++;
  // Store and AI updates from a single action settle before capturing the workspace.
  queueMicrotask(() => {
    if (pending?.sequence === sequence || sequence === committedSequence) return;
    const document = captureProjectDocument();
    if (!document.tabs.length) return;
    const { name, destination } = projectSession.getState();
    const { projectRoot, files } = getProjectState();
    pending = {
      sequence,
      record: {
        version: 1,
        document,
        name,
        destination,
        dirty: hasUnsavedProject(),
        priority: focusTime,
        ...(projectRoot ? { folder: { root: projectRoot, files } } : {}),
      },
    };
    if (!drain) drain = drainRecovery();
  });
}

async function drainRecovery() {
  try {
    while (pending) {
      const next = pending;
      pending = null;
      if (await writeRecovery(await openDatabase(), next.record)) committedSequence = next.sequence;
    }
  } catch (error) {
    notifyError({
      operation: 'save-project-recovery',
      fallbackMessage: 'Could not remember this workspace',
      toastId: 'save-project-recovery-error',
      error,
    });
  } finally {
    drain = pending ? drainRecovery() : null;
  }
}

export function needsRecoveryBeforeClose() {
  return sequence !== committedSequence;
}

export async function flushProjectRecovery() {
  await Promise.resolve();
  while (drain) await drain;
  return !needsRecoveryBeforeClose();
}

function changed() {
  if (hydrating) return;
  projectSession.setState((state) => ({ revision: state.revision + 1 }));
  if (getWorkspaceState().showWelcome) workspaceStore.getState().hideWelcomeScreen();
  queueRecovery();
}

export function startProjectRecovery() {
  focusTime = performance.timeOrigin + performance.now();
  window.addEventListener('focus', () => {
    focusTime = performance.timeOrigin + performance.now();
  });
  getProjectStore().subscribe((state, previous) => {
    if (
      state.files !== previous.files ||
      state.renderTargetPath !== previous.renderTargetPath ||
      state.emptyFolders !== previous.emptyFolders ||
      state.projectRoot !== previous.projectRoot
    ) {
      changed();
    }
  });
  workspaceStore.subscribe((state, previous) => {
    if (
      state.activeTabId !== previous.activeTabId ||
      state.tabs.length !== previous.tabs.length ||
      state.tabs.some(({ id, name, projectPath }, index) => {
        const before = previous.tabs[index];
        return before.id !== id || before.name !== name || before.projectPath !== projectPath;
      })
    ) {
      changed();
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (needsRecoveryBeforeClose()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

export function importProjectSource(
  files: Record<string, ProjectFile>,
  name: string,
  content: string,
  emptyFolders: string[] = []
) {
  const dot = name.lastIndexOf('.');
  const stem = name.slice(0, dot);
  const extension = name.slice(dot);
  let path = name;
  let index = 1;
  const directories = [...Object.keys(files), ...emptyFolders];
  while (
    Object.prototype.hasOwnProperty.call(files, path) ||
    directories.some((entry) => entry === path || entry.startsWith(path + '/'))
  ) {
    if (files[path]?.content === content) return { path, reuse: true };
    path = `${stem}_${index++}${extension}`;
  }
  return { path, reuse: false };
}
