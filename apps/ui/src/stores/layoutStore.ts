import type { DockviewApi, SerializedDockview } from 'dockview';

const LEGACY_LAYOUT_STORAGE_KEY = 'openscad-studio-layout';
const LAYOUT_STORAGE_KEYS = {
  desktop: 'openscad-studio-layout-desktop',
  mobile: 'openscad-studio-layout-mobile',
} as const;
const DEFAULT_LAYOUT_FALLBACK_WIDTH = 1000;
const DEFAULT_LAYOUT_FALLBACK_HEIGHT = 800;
const DEFAULT_FILES_WIDTH_RATIO = 0.2;
const DEFAULT_PRIMARY_WIDTH_RATIO = 0.4;
const DEFAULT_SIDEBAR_HEIGHT_RATIO = 0.5;

export const MOBILE_LAYOUT_MEDIA_QUERY = '(max-width: 767px)';

export type LayoutMode = keyof typeof LAYOUT_STORAGE_KEYS;
export type WorkspacePanelId =
  | 'ai-chat'
  | 'editor'
  | 'preview'
  | 'customizer'
  | 'console'
  | 'files';

export interface WorkspacePanelDefinition {
  id: WorkspacePanelId;
  component: WorkspacePanelId;
  title: string;
}

export const WORKSPACE_PANELS: readonly WorkspacePanelDefinition[] = [
  { id: 'ai-chat', component: 'ai-chat', title: 'AI' },
  { id: 'editor', component: 'editor', title: 'Editor' },
  { id: 'preview', component: 'preview', title: 'Preview' },
  { id: 'customizer', component: 'customizer', title: 'Customizer' },
  { id: 'console', component: 'console', title: 'Console' },
  { id: 'files', component: 'files', title: 'Files' },
];

let dockviewApi: DockviewApi | null = null;
let loadedLegacyLayout = false;

export function getDockviewApi(): DockviewApi | null {
  return dockviewApi;
}

export function setDockviewApi(api: DockviewApi | null): void {
  dockviewApi = api;
}

export function getLayoutMode(): LayoutMode {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY).matches
    ? 'mobile'
    : 'desktop';
}

export function getLayoutStorageKey(mode: LayoutMode): string {
  return LAYOUT_STORAGE_KEYS[mode];
}

function addPanelToGroup(
  api: DockviewApi,
  panel: WorkspacePanelDefinition,
  groupId: string,
  inactive = true
) {
  api.addPanel({
    ...panel,
    position: { referenceGroup: groupId },
    inactive,
  });
}

function addMobilePanels(api: DockviewApi) {
  api.addPanel(WORKSPACE_PANELS[0]);
  const aiPanel = api.getPanel('ai-chat');
  if (!aiPanel) return;

  for (const panel of WORKSPACE_PANELS.slice(1)) {
    addPanelToGroup(api, panel, aiPanel.group.id);
  }
}

function getDefaultLayoutSizes(api: DockviewApi) {
  const availableWidth = api.width > 0 ? api.width : DEFAULT_LAYOUT_FALLBACK_WIDTH;
  const availableHeight = api.height > 0 ? api.height : DEFAULT_LAYOUT_FALLBACK_HEIGHT;
  return {
    files: Math.round(availableWidth * DEFAULT_FILES_WIDTH_RATIO),
    primary: Math.round(availableWidth * DEFAULT_PRIMARY_WIDTH_RATIO),
    sidebar: Math.round(availableHeight * DEFAULT_SIDEBAR_HEIGHT_RATIO),
  };
}

export function addDefaultPanels(api: DockviewApi, mode: LayoutMode = 'desktop') {
  if (mode === 'mobile') {
    addMobilePanels(api);
    return;
  }

  const sizes = getDefaultLayoutSizes(api);

  api.addPanel(WORKSPACE_PANELS[0]);
  const aiPanel = api.getPanel('ai-chat');
  if (aiPanel) {
    addPanelToGroup(api, WORKSPACE_PANELS[1], aiPanel.group.id);
  }

  api.addPanel({
    ...WORKSPACE_PANELS[2],
    position: { referencePanel: 'ai-chat', direction: 'right' },
    initialWidth: sizes.primary,
  });
  const previewPanel = api.getPanel('preview');
  if (previewPanel) {
    addPanelToGroup(api, WORKSPACE_PANELS[4], previewPanel.group.id);
  }

  const filesPanel = api.addPanel({
    ...WORKSPACE_PANELS[5],
    position: { referencePanel: 'ai-chat', direction: 'left' },
    initialWidth: sizes.files,
  });
  const customizerPanel = api.addPanel({
    ...WORKSPACE_PANELS[3],
    position: { referencePanel: 'files', direction: 'below' },
    initialHeight: sizes.sidebar,
  });

  // Apply final sizes after the nested sidebar split exists: the left column is
  // 20% wide with Files and Customizer at 50% height, while AI and Preview are 40% each.
  filesPanel.api.setSize({ width: sizes.files });
  customizerPanel.api.setSize({ height: sizes.sidebar });
  previewPanel?.api.setSize({ width: sizes.primary });
  aiPanel?.api.setActive();
}

export function saveLayout(mode: LayoutMode = getLayoutMode()): void {
  if (!dockviewApi) return;
  try {
    localStorage.setItem(getLayoutStorageKey(mode), JSON.stringify(dockviewApi.toJSON()));
  } catch (error) {
    console.error('Failed to save layout:', error);
  }
}

export function loadLayout(mode: LayoutMode = getLayoutMode()): SerializedDockview | null {
  const storageKey = getLayoutStorageKey(mode);
  let saved = localStorage.getItem(storageKey);
  loadedLegacyLayout = false;

  if (!saved && mode === 'desktop') {
    saved = localStorage.getItem(LEGACY_LAYOUT_STORAGE_KEY);
    if (saved) {
      loadedLegacyLayout = true;
      localStorage.setItem(storageKey, saved);
      localStorage.removeItem(LEGACY_LAYOUT_STORAGE_KEY);
    }
  }

  if (!saved) return null;

  try {
    return JSON.parse(saved) as SerializedDockview;
  } catch (error) {
    console.error('Failed to parse saved layout:', error);
    localStorage.removeItem(storageKey);
    return null;
  }
}

export function restoreLayout(api: DockviewApi, mode: LayoutMode = getLayoutMode()): boolean {
  const saved = loadLayout(mode);
  if (!saved) return false;

  try {
    api.fromJSON(saved);
    if (
      loadedLegacyLayout &&
      !api.panels.some((panel) => panel.api.component === 'files')
    ) {
      const files = WORKSPACE_PANELS.find((panel) => panel.id === 'files');
      const referencePanel = api.panels[0];
      if (files && referencePanel) {
        const sizes = getDefaultLayoutSizes(api);
        api.addPanel({
          ...files,
          position: { referencePanel: referencePanel.id, direction: 'left' },
          initialWidth: sizes.files,
        });
      } else if (files) {
        api.addPanel(files);
      }
      localStorage.setItem(getLayoutStorageKey(mode), JSON.stringify(api.toJSON()));
    }
    return true;
  } catch (error) {
    console.error('Failed to restore saved layout:', error);
    api.clear();
    clearSavedLayout(mode);
    return false;
  }
}

export function clearSavedLayout(mode: LayoutMode = getLayoutMode()): void {
  localStorage.removeItem(getLayoutStorageKey(mode));
  if (mode === 'desktop') {
    localStorage.removeItem(LEGACY_LAYOUT_STORAGE_KEY);
  }
}

export function resetLayout(mode: LayoutMode = getLayoutMode()): void {
  clearSavedLayout(mode);
  if (!dockviewApi) return;

  dockviewApi.clear();
  addDefaultPanels(dockviewApi, mode);
  saveLayout(mode);
}

export function openPanel(panelId: WorkspacePanelId): void {
  if (!dockviewApi) return;

  const definition = WORKSPACE_PANELS.find((panel) => panel.id === panelId);
  if (!definition) return;

  const existing = dockviewApi.panels.find(
    (panel) => panel.id === panelId || panel.api.component === definition.component
  );
  if (existing) {
    existing.api.setActive();
    return;
  }

  const targetGroup =
    dockviewApi.activeGroup ?? dockviewApi.groups[dockviewApi.groups.length - 1];
  if (targetGroup) {
    dockviewApi.addPanel({
      ...definition,
      position: { referenceGroup: targetGroup.id },
    });
  } else {
    dockviewApi.addPanel(definition);
  }
}
