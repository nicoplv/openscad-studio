/** @jest-environment jsdom */

import { jest } from '@jest/globals';
import { getProjectStore } from '../../stores/projectStore';
import {
  flushProjectRecovery,
  hasUnsavedProject,
  importProjectSource,
  initializeStarterProject,
  saveCurrentProject,
  startProjectRecovery,
} from '../projectLifecycle';
import { decodeProjectArchive } from '../../utils/projectZip';
import { updateSetting } from '../../stores/settingsStore';

describe('project lifecycle', () => {
  beforeAll(() => {
    startProjectRecovery();
    updateSetting('editor', { formatOnSave: false });
  });

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    initializeStarterProject();
  });
  afterEach(async () => {
    await flushProjectRecovery();
    jest.restoreAllMocks();
  });

  it('keeps the project dirty when the save dialog is cancelled', async () => {
    getProjectStore().getState().updateFileContent('main.scad', 'cube(5);');

    expect(await saveCurrentProject(false, async () => null)).toBe(false);
    expect(hasUnsavedProject()).toBe(true);
  });

  it('marks only the written revision as saved when edits arrive during a save', async () => {
    const project = getProjectStore().getState();
    project.updateFileContent('main.scad', 'cube(5);');
    let finishSave!: () => Promise<void>;
    const write = jest.fn<typeof import('../../platform/projectFile').writeProjectArchive>();
    write.mockImplementation(
      (getBytes) =>
        new Promise((resolve) => {
          finishSave = async () => {
            expect(
              decodeProjectArchive(await getBytes(), 'test.oscadstudio').document.files['main.scad']
            ).toBe('cube(5);');
            resolve({ name: 'test.oscadstudio', destination: null });
          };
        })
    );

    const saving = saveCurrentProject(false, write);
    project.updateFileContent('main.scad', 'cube(6);');
    await finishSave();

    expect(await saving).toBe(true);
    expect(getProjectStore().getState().files['main.scad']).toMatchObject({
      savedContent: 'cube(5);',
      content: 'cube(6);',
      isDirty: true,
    });
    expect(hasUnsavedProject()).toBe(true);
    expect(
      await saveCurrentProject(false, async () => ({ name: 'test.oscadstudio', destination: null }))
    ).toBe(true);
    expect(hasUnsavedProject()).toBe(false);
  });

  it('reuses identical imports and preserves files and folders with conflicting names', () => {
    const files = getProjectStore().getState().files;
    expect(importProjectSource(files, 'main.scad', files['main.scad'].content)).toEqual({
      path: 'main.scad',
      reuse: true,
    });
    expect(importProjectSource(files, 'main.scad', 'sphere(2);', ['main_1.scad'])).toEqual({
      path: 'main_2.scad',
      reuse: false,
    });
  });
});
