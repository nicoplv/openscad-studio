import { getPlatform } from '.';
import { loadSettings } from '../stores/settingsStore';
import { PROJECT_EXTENSION } from '../utils/projectZip';
import type { ProjectFileHandle } from './webBridge';

export type ProjectDestination =
  | { kind: 'desktop'; path: string }
  | { kind: 'browser'; handle: ProjectFileHandle };

export interface PickedProject {
  bytes: Uint8Array;
  name: string;
  destination: ProjectDestination | null;
}

const types = [
  {
    description: 'OpenSCAD Studio Project',
    accept: { 'application/zip': [`.${PROJECT_EXTENSION}`] },
  },
];
const desktopFilter = { name: 'OpenSCAD Studio Project', extensions: [PROJECT_EXTENSION] };

export async function pickProjectArchive(): Promise<PickedProject | null> {
  try {
    if (getPlatform().capabilities.hasFileSystem) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({
        filters: [{ ...desktopFilter, extensions: [PROJECT_EXTENSION, 'zip'] }],
        multiple: false,
      });
      if (!path) return null;
      const { readFile } = await import('@tauri-apps/plugin-fs');
      return {
        bytes: await readFile(path),
        name: path.split(/[/\\\\]/).pop() ?? path,
        destination: { kind: 'desktop', path },
      };
    }

    if (typeof window.showOpenFilePicker === 'function') {
      const [handle] = await window.showOpenFilePicker({
        types: [{ ...types[0], accept: { 'application/zip': [`.${PROJECT_EXTENSION}`, '.zip'] } }],
      });
      if (!handle) return null;
      const file = await handle.getFile();
      return {
        bytes: new Uint8Array(await file.arrayBuffer()),
        name: file.name,
        destination: { kind: 'browser', handle },
      };
    }

    const file = await new Promise<File | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = `.${PROJECT_EXTENSION},.zip`;
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.oncancel = () => resolve(null);
      input.click();
    });
    return file
      ? { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, destination: null }
      : null;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

export async function writeProjectArchive(
  getBytes: () => Promise<Uint8Array<ArrayBuffer>>,
  name: string,
  destination: ProjectDestination | null
): Promise<{ name: string; destination: ProjectDestination | null } | null> {
  try {
    if (getPlatform().capabilities.hasFileSystem) {
      const { invoke } = await import('@tauri-apps/api/core');
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { join } = await import('@tauri-apps/api/path');
      const directory = loadSettings().project.defaultProjectDirectory;
      const pickDestination = (defaultPath: string) =>
        save({ defaultPath, filters: [desktopFilter] });
      const write = async (path: string, bytes: Uint8Array<ArrayBuffer>) => {
        const encodedPath = new TextEncoder().encode(path);
        const payload = new Uint8Array(encodedPath.length + 1 + bytes.length);
        payload.set(encodedPath);
        payload.set(bytes, encodedPath.length + 1);
        await invoke('write_project_archive', payload);
      };

      let path =
        destination?.kind === 'desktop'
          ? destination.path
          : await pickDestination(directory ? await join(directory, name) : name);
      if (!path) return null;
      const bytes = await getBytes();
      try {
        await write(path, bytes);
      } catch (error) {
        if (destination?.kind !== 'desktop' || error !== 'Project destination needs permission.')
          throw error;
        path = await pickDestination(path);
        if (!path) return null;
        await write(path, bytes);
      }
      return { name: path.split(/[/\\]/).pop() ?? path, destination: { kind: 'desktop', path } };
    }

    if (typeof window.showSaveFilePicker !== 'function') {
      await getPlatform().fileExport(await getBytes(), name);
      return { name, destination: null };
    }

    const handle =
      destination?.kind === 'browser'
        ? destination.handle
        : await window.showSaveFilePicker({ types, suggestedName: name });
    if (destination?.kind === 'browser' && handle.requestPermission) {
      const permission = { mode: 'readwrite' as const };
      if (
        (await handle.queryPermission?.(permission)) !== 'granted' &&
        (await handle.requestPermission(permission)) !== 'granted'
      ) {
        throw new Error('Write access was denied. Use Save Project As to choose a destination.');
      }
    }
    const bytes = await getBytes();
    const stream = await handle.createWritable();
    try {
      await stream.write(bytes);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
    return { name: handle.name, destination: { kind: 'browser', handle } };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}
