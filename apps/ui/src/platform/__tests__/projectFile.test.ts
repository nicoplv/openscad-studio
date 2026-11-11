/** @jest-environment jsdom */

import { jest } from '@jest/globals';
import { writeProjectArchive } from '../projectFile';

it('reuses the browser project file handle after requesting write access', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const write = jest.fn();
  const close = jest.fn();
  const handle = {
    name: 'part.oscadstudio',
    createWritable: jest.fn(async () => ({ write, close, abort: jest.fn() })),
    queryPermission: jest.fn(async () => 'prompt'),
    requestPermission: jest.fn(async () => 'granted'),
  };
  const picker = jest.fn(async () => handle);
  Object.defineProperty(window, 'showSaveFilePicker', { value: picker, configurable: true });
  try {
    const first = await writeProjectArchive(async () => bytes, 'part.oscadstudio', null);
    expect(first?.destination).toEqual({ kind: 'browser', handle });

    await writeProjectArchive(async () => bytes, 'part.oscadstudio', first!.destination);
    expect(picker).toHaveBeenCalledTimes(1);
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(bytes);
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  }
});
