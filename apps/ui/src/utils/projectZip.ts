import { zipSync, unzipSync, strToU8, strFromU8, type Zippable } from 'fflate';
import {
  isOpenScadProjectFilePath,
  pickOpenScadRenderTarget,
} from '../../../../packages/shared/src/openscadProjectFiles';

import {
  EMPTY_CONVERSATIONS,
  projectDocumentSchema,
  type ProjectDocument,
} from '../stores/projectDocument';
import { createWorkspaceTab } from '../stores/workspaceFactories';

const MANIFEST_FILENAME = '.openscad-studio.json';

interface ProjectManifest {
  version: 1;
  renderTarget: string;
}

export interface ProjectExportData {
  files: Record<string, string>;
  renderTargetPath: string;
}

export interface ProjectImportResult {
  files: Record<string, string>;
  renderTargetPath: string;
}

/**
 * Export project files as a ZIP blob.
 * Includes a manifest with the render target path.
 */
export function exportProjectZip(data: ProjectExportData): Blob {
  const zipData: Record<string, Uint8Array> = {};

  // Add all project files
  for (const [path, content] of Object.entries(data.files)) {
    zipData[path] = strToU8(content);
  }

  // Add manifest
  const manifest: ProjectManifest = {
    version: 1,
    renderTarget: data.renderTargetPath,
  };
  zipData[MANIFEST_FILENAME] = strToU8(JSON.stringify(manifest, null, 2));

  const zipped = zipSync(zipData);
  return new Blob([zipped], { type: 'application/zip' });
}

/**
 * Import a project from a ZIP blob.
 * Reads the manifest to determine the render target.
 * Falls back to the first renderable `.scad` file if no manifest is present.
 */
export async function importProjectZip(blob: Blob): Promise<ProjectImportResult> {
  const buffer = await blob.arrayBuffer();
  const unzipped = unzipSync(new Uint8Array(buffer));

  const files: Record<string, string> = {};
  let manifest: ProjectManifest | null = null;

  for (const [path, data] of Object.entries(unzipped)) {
    // Skip macOS resource fork files and hidden OS files
    if (path.startsWith('__MACOSX/') || path.startsWith('.DS_Store')) continue;

    if (path === MANIFEST_FILENAME) {
      try {
        manifest = JSON.parse(strFromU8(data));
      } catch {
        // Ignore malformed manifest
      }
      continue;
    }

    if (isOpenScadProjectFilePath(path)) {
      files[path] = strFromU8(data);
    }
  }

  const renderTargetPath =
    (manifest?.renderTarget && manifest.renderTarget in files ? manifest.renderTarget : null) ??
    pickOpenScadRenderTarget(Object.keys(files));

  if (!renderTargetPath) {
    throw new Error('ZIP contains no renderable .scad files');
  }

  return { files, renderTargetPath };
}

export const PROJECT_EXTENSION = 'oscadstudio';

function encodeSources(files: Record<string, string>, emptyFolders: string[] = []): Zippable {
  const entries: Zippable = Object.create(null);
  for (const [path, content] of Object.entries(files)) entries[path] = strToU8(content);
  for (const path of emptyFolders) entries[`${path}/`] = new Uint8Array();
  return entries;
}

export function exportProjectSources(document: Pick<ProjectDocument, 'files' | 'emptyFolders'>) {
  return zipSync(encodeSources(document.files, document.emptyFolders));
}

export function encodeProjectArchive(document: ProjectDocument) {
  const { files, ...metadata } = document;
  const entries = encodeSources(files);
  entries[MANIFEST_FILENAME] = strToU8(JSON.stringify({ version: 2, ...metadata }));
  return zipSync(entries);
}

export function createProjectDocument(
  files: Record<string, string>,
  renderTargetPath: string,
  emptyFolders: string[] = []
): ProjectDocument {
  const tab = createWorkspaceTab({ name: renderTargetPath, projectPath: renderTargetPath });
  return {
    files,
    renderTargetPath,
    emptyFolders,
    tabs: [{ id: tab.id, name: tab.name, projectPath: tab.projectPath }],
    activeTabId: tab.id,
    ai: EMPTY_CONVERSATIONS,
  };
}

export function decodeProjectArchive(bytes: Uint8Array, name: string) {
  const entries = unzipSync(bytes);
  const rawManifest = entries[MANIFEST_FILENAME];
  const manifest: unknown = rawManifest ? JSON.parse(strFromU8(rawManifest)) : null;
  const version =
    manifest && typeof manifest === 'object' && 'version' in manifest ? manifest.version : null;
  const files = Object.fromEntries(
    Object.entries(entries)
      .filter(([path]) =>
        version === 2
          ? path !== MANIFEST_FILENAME && !path.endsWith('/')
          : !path.startsWith('__MACOSX/') && isOpenScadProjectFilePath(path)
      )
      .map(([path, data]) => [path, strFromU8(data)])
  );

  if (version === 2 && manifest && typeof manifest === 'object') {
    return { document: projectDocumentSchema.parse({ ...manifest, files }), legacy: false };
  }

  const legacy = name.toLowerCase().endsWith('.zip');
  const legacyManifest =
    manifest && typeof manifest === 'object' && 'version' in manifest && manifest.version === 1
      ? (manifest as ProjectManifest)
      : null;
  if (!legacy || (rawManifest && !legacyManifest)) {
    throw new Error('This project archive has an unsupported manifest.');
  }
  const target = pickOpenScadRenderTarget(Object.keys(files), legacyManifest?.renderTarget);
  if (!target) throw new Error('ZIP contains no renderable .scad files');
  return { document: projectDocumentSchema.parse(createProjectDocument(files, target)), legacy };
}
