import { expect, test } from '../../fixtures/app.fixture';
import { mockSimpleAiResponse } from '../../helpers/ai-mock';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';

async function fileCommand(page: Page, label: string) {
  await page.getByText('File', { exact: true }).first().click();
  await page.getByText(label, { exact: true }).click();
}

test('recovers a project and reopens its portable archive with both AI conversations', async ({
  app,
}) => {
  const { page } = app;
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await app.configureAnthropicApiKey();
  await app.openEditorPanel();

  const sourcePicker = page.waitForEvent('filechooser');
  await fileCommand(page, 'Open File...');
  await (
    await sourcePicker
  ).setFiles({
    name: 'part.scad',
    mimeType: 'text/plain',
    buffer: Buffer.from('sphere(5);'),
  });
  await expect.poll(() => app.getEditorContent()).toBe('sphere(5);');
  await app.setEditorContent('sphere(8);');
  const part = page.locator('button[title="part.scad"]');
  await part.click({ button: 'right' });
  await page.getByText('Set as Render Target', { exact: true }).click();
  await expect(part.getByTitle('Render target')).toBeVisible();

  await app.openAiPanel();
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 4;
      canvas.getContext('2d')?.fillRect(0, 0, 4, 4);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64'
  );
  await page.getByTestId('ai-composer').locator('input[type=file]').setInputFiles({
    name: 'reference.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await app.aiChatInput.fill('Use this reference');
  await mockSimpleAiResponse(page, 'First answer');
  await app.aiSubmitButton.click();
  await expect(app.aiTranscript).toContainText('First answer');
  await page.getByTestId('ai-new-conversation-button').click();
  await app.aiChatInput.fill('Check the current part');
  await mockSimpleAiResponse(page, 'Second answer');
  await app.aiSubmitButton.click();
  await expect(app.aiTranscript).toContainText('Second answer');

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const request = indexedDB.open('openscad-studio-recovery');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const read = db.transaction('workspace').objectStore('workspace').get('last');
              read.onsuccess = () => {
                const stored = read.result?.document;
                db.close();
                resolve(
                  stored?.files?.['part.scad'] === 'sphere(8);' ? stored.ai.conversations.length : 0
                );
              };
              read.onerror = () => reject(read.error);
            };
          })
      )
    )
    .toBe(2);

  await page.reload();
  await app.openEditorPanel();
  await expect.poll(() => app.getEditorContent()).toContain('sphere(8);');
  await expect(part.getByTitle('Render target')).toBeVisible();
  await app.openAiPanel();
  await expect(app.aiTranscript).toContainText('Second answer');

  const download = page.waitForEvent('download');
  await fileCommand(page, 'Save Project');
  const archive = await download;
  expect(archive.suggestedFilename()).toMatch(/\.oscadstudio$/);
  const path = await archive.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();

  await fileCommand(page, 'New Project');
  await app.openEditorPanel();
  await expect.poll(() => app.getEditorContent()).toContain('cube([10, 10, 10]);');

  const projectPicker = page.waitForEvent('filechooser');
  await fileCommand(page, 'Open Project...');
  await (
    await projectPicker
  ).setFiles({
    name: archive.suggestedFilename(),
    mimeType: 'application/zip',
    buffer: bytes,
  });
  await expect.poll(() => app.getEditorContent()).toContain('sphere(8);');
  await expect(part.getByTitle('Render target')).toBeVisible();
  await app.openAiPanel();
  await expect(app.aiTranscript).toContainText('Second answer');
  await page.getByRole('combobox', { name: 'AI conversation' }).click();
  await page.getByRole('option', { name: 'Use this reference' }).click();
  await expect(app.aiTranscript).toContainText('First answer');
  await expect(app.aiTranscript.getByRole('img', { name: 'reference.png' })).toBeVisible();

  const allSources = page.waitForEvent('download');
  await fileCommand(page, 'Export All...');
  expect((await allSources).suggestedFilename()).toMatch(/\.zip$/);
});
