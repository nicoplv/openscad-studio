import { unzipSync, strFromU8 } from 'fflate';
import {
  createProjectDocument,
  decodeProjectArchive,
  encodeProjectArchive,
  exportProjectSources,
  exportProjectZip,
  importProjectZip,
} from '../projectZip';

describe('exportProjectZip', () => {
  it('produces a valid ZIP blob', () => {
    const blob = exportProjectZip({
      files: { 'main.scad': 'cube(10);' },
      renderTargetPath: 'main.scad',
    });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/zip');
    expect(blob.size).toBeGreaterThan(0);
  });
});

describe('importProjectZip', () => {
  it('round-trips a single-file project', async () => {
    const blob = exportProjectZip({
      files: { 'main.scad': 'cube(10);' },
      renderTargetPath: 'main.scad',
    });
    const result = await importProjectZip(blob);
    expect(result.files).toEqual({ 'main.scad': 'cube(10);' });
    expect(result.renderTargetPath).toBe('main.scad');
  });

  it('round-trips a multi-file project', async () => {
    const files = {
      'main.scad': 'include <lib/constants.h>\nuse <lib/utils.scad>\ncube(size);',
      'lib/constants.h': 'size = 10;',
      'lib/utils.scad': 'module helper() { cube(5); }',
    };
    const blob = exportProjectZip({
      files,
      renderTargetPath: 'main.scad',
    });
    const result = await importProjectZip(blob);
    expect(result.files).toEqual(files);
    expect(result.renderTargetPath).toBe('main.scad');
  });

  it('preserves a non-default render target', async () => {
    const files = {
      'main.scad': 'cube(10);',
      'entry.scad': 'sphere(5);',
    };
    const blob = exportProjectZip({
      files,
      renderTargetPath: 'entry.scad',
    });
    const result = await importProjectZip(blob);
    expect(result.renderTargetPath).toBe('entry.scad');
  });

  it('falls back to main.scad when manifest is missing', async () => {
    // Build a ZIP without a manifest by exporting then re-importing with tampered data
    const { zipSync, strToU8 } = await import('fflate');
    const zipData: Record<string, Uint8Array> = {
      'main.scad': strToU8('cube(10);'),
      'other.scad': strToU8('sphere(5);'),
    };
    const zipped = zipSync(zipData);
    const blob = new Blob([zipped], { type: 'application/zip' });

    const result = await importProjectZip(blob);
    expect(result.renderTargetPath).toBe('main.scad');
    expect(Object.keys(result.files).sort()).toEqual(['main.scad', 'other.scad']);
  });

  it('falls back to first alphabetical file when no manifest and no main.scad', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const zipData: Record<string, Uint8Array> = {
      'beta.scad': strToU8('cube(10);'),
      'alpha.scad': strToU8('sphere(5);'),
    };
    const zipped = zipSync(zipData);
    const blob = new Blob([zipped], { type: 'application/zip' });

    const result = await importProjectZip(blob);
    expect(result.renderTargetPath).toBe('alpha.scad');
  });

  it('keeps supported header files and ignores unrelated files', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const zipData: Record<string, Uint8Array> = {
      'main.scad': strToU8('cube(10);'),
      'lib/constants.h': strToU8('size = 10;'),
      'readme.txt': strToU8('not a scad file'),
      '__MACOSX/._main.scad': strToU8('resource fork'),
      '.DS_Store': strToU8('ds store'),
    };
    const zipped = zipSync(zipData);
    const blob = new Blob([zipped], { type: 'application/zip' });

    const result = await importProjectZip(blob);
    expect(Object.keys(result.files).sort()).toEqual(['lib/constants.h', 'main.scad']);
  });

  it('throws when ZIP contains no renderable .scad files', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const zipData: Record<string, Uint8Array> = {
      'constants.h': strToU8('size = 10;'),
    };
    const zipped = zipSync(zipData);
    const blob = new Blob([zipped], { type: 'application/zip' });

    await expect(importProjectZip(blob)).rejects.toThrow('ZIP contains no renderable .scad files');
  });
});

describe('portable project archives', () => {
  it('round-trips files, tabs, render target and conversation history with an attachment', () => {
    const document = createProjectDocument(
      { 'main.scad': 'include <lib/sizes.h>\ncube(size);', 'lib/sizes.h': 'size = 4;' },
      'main.scad',
      ['empty']
    );
    document.tabs.push({ id: 'sizes', name: 'sizes.h', projectPath: 'lib/sizes.h' });
    document.activeTabId = 'sizes';
    document.ai = {
      activeId: 'second',
      conversations: [
        {
          id: 'first',
          lastUsed: 1,
          messages: [
            {
              id: 'prompt',
              type: 'user',
              timestamp: 1,
              checkpointId: 'checkpoint',
              parts: [{ type: 'text', text: 'Make it larger' }],
            },
          ],
          draft: { text: '', attachmentIds: [] },
          attachments: {},
          checkpoints: { checkpoint: { path: 'main.scad', code: 'cube(3);' } },
        },
        {
          id: 'second',
          lastUsed: 2,
          messages: [],
          draft: { text: 'Use this reference', attachmentIds: ['picture'] },
          attachments: {
            picture: {
              id: 'picture',
              filename: 'reference.png',
              sourceMimeType: 'image/png',
              status: 'ready',
              sizeBytes: 3,
              dedupeKey: 'picture',
              normalizedMimeType: 'image/png',
              normalizedData: 'AQID',
            },
          },
          checkpoints: {},
        },
      ],
    };
    const bytes = encodeProjectArchive(document);
    expect(decodeProjectArchive(bytes, 'model.oscadstudio')).toEqual({ document, legacy: false });

    const sources = unzipSync(exportProjectSources(document));
    expect(Object.keys(sources).sort()).toEqual(['empty/', 'lib/sizes.h', 'main.scad']);
    expect(strFromU8(sources['lib/sizes.h'])).toBe('size = 4;');
  });

  it('imports a version 1 ZIP with its render target', async () => {
    const zip = exportProjectZip({
      files: { 'main.scad': 'cube(1);', 'other.scad': 'sphere(2);' },
      renderTargetPath: 'other.scad',
    });
    const result = decodeProjectArchive(new Uint8Array(await zip.arrayBuffer()), 'legacy.zip');
    expect(result.legacy).toBe(true);
    expect(result.document.renderTargetPath).toBe('other.scad');
    expect(result.document.tabs[0].projectPath).toBe('other.scad');
  });

  it('rejects escaping paths and tabs pointing outside the source tree', () => {
    const document = createProjectDocument({ 'main.scad': 'cube(1);' }, 'main.scad');
    document.files['../other.scad'] = 'cube(2);';
    expect(() =>
      decodeProjectArchive(encodeProjectArchive(document), 'model.oscadstudio')
    ).toThrow();
    delete document.files['../other.scad'];
    document.tabs[0].projectPath = 'missing.scad';
    expect(() =>
      decodeProjectArchive(encodeProjectArchive(document), 'model.oscadstudio')
    ).toThrow();
  });
});
