/** @jest-environment jsdom */

import { jest } from '@jest/globals';
import type { DockviewApi, SerializedDockview } from 'dockview';
import {
  addDefaultPanels,
  getLayoutStorageKey,
  loadLayout,
  openPanel,
  resetLayout,
  restoreLayout,
  saveLayout,
  setDockviewApi,
} from '../layoutStore';

type MockAddPanelOptions = {
  id: string;
  component: string;
  title: string;
  position?: {
    referenceGroup?: string;
    referencePanel?: string;
    direction?: 'above' | 'below' | 'left' | 'right';
  };
  inactive?: boolean;
  initialWidth?: number;
};

type MockGroup = { id: string };
type MockPanel = {
  id: string;
  group: MockGroup;
  api: {
    component: string;
    group: MockGroup;
    setActive: ReturnType<typeof jest.fn>;
    setSize: ReturnType<typeof jest.fn>;
  };
};

class MockDockview {
  width = 1000;
  height = 800;
  groups: MockGroup[] = [];
  panels: MockPanel[] = [];
  activeGroup: MockGroup | undefined;
  addPanelCalls: MockAddPanelOptions[] = [];
  fromJSON = jest.fn(() => {});
  toJSON = jest.fn(
    () => ({ marker: 'layout' }) as unknown as SerializedDockview
  );
  clear = jest.fn(() => {
    this.groups = [];
    this.panels = [];
    this.activeGroup = undefined;
  });

  addPanel(options: MockAddPanelOptions) {
    this.addPanelCalls.push(options);

    let group = options.position?.referenceGroup
      ? this.groups.find((candidate) => candidate.id === options.position?.referenceGroup)
      : undefined;
    if (!group) {
      group = { id: `group-${this.groups.length + 1}` };
      this.groups.push(group);
    }

    const panel: MockPanel = {
      id: options.id,
      group,
      api: {
        component: options.component,
        group,
        setActive: jest.fn(),
        setSize: jest.fn(),
      },
    };
    this.panels.push(panel);
    this.activeGroup = group;
    return panel;
  }

  getPanel(id: string) {
    return this.panels.find((panel) => panel.id === id);
  }
}

function createMockApi(): MockDockview & DockviewApi {
  return new MockDockview() as MockDockview & DockviewApi;
}

describe('layoutStore', () => {
  beforeEach(() => {
    localStorage.clear();
    setDockviewApi(null);
  });

  afterEach(() => {
    setDockviewApi(null);
  });

  it('creates an AI-first desktop layout with Files as a dock panel', () => {
    const api = createMockApi();
    api.width = 1250;
    api.height = 900;

    addDefaultPanels(api, 'desktop');

    expect(api.addPanelCalls.map((call) => call.id)).toEqual([
      'ai-chat',
      'editor',
      'preview',
      'console',
      'files',
      'customizer',
    ]);
    expect(api.addPanelCalls[2]?.initialWidth).toBe(500);
    expect(api.addPanelCalls[4]).toEqual(
      expect.objectContaining({
        initialWidth: 250,
        position: { referencePanel: 'ai-chat', direction: 'left' },
      })
    );
    expect(api.addPanelCalls[5]).toEqual(
      expect.objectContaining({
        initialHeight: 450,
        position: { referencePanel: 'files', direction: 'below' },
      })
    );
    expect(api.getPanel('ai-chat')?.group.id).toBe(api.getPanel('editor')?.group.id);
    expect(api.getPanel('preview')?.group.id).toBe(api.getPanel('console')?.group.id);
    expect(api.getPanel('files')?.group.id).not.toBe(api.getPanel('customizer')?.group.id);
    expect(api.getPanel('files')?.api.setSize).toHaveBeenCalledWith({ width: 250 });
    expect(api.getPanel('customizer')?.api.setSize).toHaveBeenCalledWith({ height: 450 });
    expect(api.getPanel('preview')?.api.setSize).toHaveBeenCalledWith({ width: 500 });
    expect(api.getPanel('ai-chat')?.api.setActive).toHaveBeenCalledTimes(1);
  });

  it('uses one AI-active tab group on mobile', () => {
    const api = createMockApi();

    addDefaultPanels(api, 'mobile');

    expect(api.addPanelCalls.map((call) => call.id)).toEqual([
      'ai-chat',
      'editor',
      'preview',
      'customizer',
      'console',
      'files',
    ]);
    expect(api.addPanelCalls[0]?.inactive).toBeUndefined();
    expect(new Set(api.panels.map((panel) => panel.group.id)).size).toBe(1);
  });

  it('stores desktop and mobile layouts independently', () => {
    const api = createMockApi();
    setDockviewApi(api);

    saveLayout('desktop');
    saveLayout('mobile');

    expect(localStorage.getItem(getLayoutStorageKey('desktop'))).toBe('{"marker":"layout"}');
    expect(localStorage.getItem(getLayoutStorageKey('mobile'))).toBe('{"marker":"layout"}');
  });

  it('migrates the legacy layout into the desktop bucket', () => {
    localStorage.setItem('openscad-studio-layout', '{"marker":"legacy"}');

    expect(loadLayout('desktop')).toEqual({ marker: 'legacy' });
    expect(localStorage.getItem(getLayoutStorageKey('desktop'))).toBe('{"marker":"legacy"}');
    expect(localStorage.getItem('openscad-studio-layout')).toBeNull();
    expect(loadLayout('mobile')).toBeNull();
  });

  it('adds Files when restoring a layout saved before Files was docked', () => {
    const api = createMockApi();
    localStorage.setItem('openscad-studio-layout', '{"marker":"legacy"}');

    expect(restoreLayout(api, 'desktop')).toBe(true);
    expect(api.addPanelCalls).toEqual([
      expect.objectContaining({ id: 'files', component: 'files', title: 'Files' }),
    ]);
  });

  it('clears a layout that Dockview cannot restore', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const api = createMockApi();
    api.fromJSON.mockImplementation(() => {
      throw new Error('invalid layout');
    });
    localStorage.setItem(getLayoutStorageKey('desktop'), '{"marker":"broken"}');

    expect(restoreLayout(api, 'desktop')).toBe(false);
    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(getLayoutStorageKey('desktop'))).toBeNull();
    consoleError.mockRestore();
  });

  it('activates an existing panel by component instead of duplicating it', () => {
    const api = createMockApi();
    const panel = api.addPanel({ id: 'editor-copy', component: 'editor', title: 'Editor' });
    setDockviewApi(api);

    openPanel('editor');

    expect(panel.api.setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanelCalls).toHaveLength(1);
  });

  it('reopens a closed panel in the active group', () => {
    const api = createMockApi();
    const ai = api.addPanel({ id: 'ai-chat', component: 'ai-chat', title: 'AI' });
    setDockviewApi(api);

    openPanel('files');

    expect(api.addPanelCalls[1]).toEqual(
      expect.objectContaining({
        id: 'files',
        position: { referenceGroup: ai.group.id },
      })
    );
  });

  it('resets the current layout to the AI-first default and persists it', () => {
    const api = createMockApi();
    setDockviewApi(api);
    localStorage.setItem(getLayoutStorageKey('desktop'), '{"marker":"custom"}');

    resetLayout('desktop');

    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(api.addPanelCalls.map((call) => call.id)).toEqual([
      'ai-chat',
      'editor',
      'preview',
      'console',
      'files',
      'customizer',
    ]);
    expect(localStorage.getItem(getLayoutStorageKey('desktop'))).toBe('{"marker":"layout"}');
  });
});
