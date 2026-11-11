import { test, expect } from '../../fixtures/app.fixture';

test.describe('Panel layout', () => {
  test('default layout is AI-first and includes Files and Preview', async ({ app }) => {
    await expect(app.page.getByText('AI', { exact: true }).first()).toBeVisible();
    await expect(app.page.getByRole('button', { name: 'Close Files' })).toBeVisible();
    await app.waitForRender();
    await expect(app.previewCanvas3D).toBeVisible();
  });

  test('does not show NUX layout picker on first run', async ({ app }) => {
    // Clear stored state to simulate first run
    await app.page.evaluate(() => localStorage.clear());
    await app.page.reload();

    await expect(app.page.getByTestId('nux-layout-picker')).toHaveCount(0);
    await expect(app.page.getByTestId('app-container')).toBeVisible({ timeout: 10_000 });
  });

  test('first run has no workspace preset selector', async ({ app }) => {
    await app.page.evaluate(() => localStorage.clear());
    await app.page.reload();

    await expect(app.page.getByTestId('app-container')).toBeVisible({ timeout: 10_000 });

    await expect(app.page.getByRole('group', { name: 'Workspace layout' })).toHaveCount(0);
    await expect(app.page.getByRole('button', { name: 'Close AI' })).toBeVisible();
  });

  test('closed panels persist and reopen from Window', async ({ app }) => {
    await app.page.getByRole('button', { name: 'Close Files' }).click();
    await expect(app.page.getByTestId('file-tree-root')).toHaveCount(0);
    await app.page.waitForTimeout(400);
    await app.page.reload();

    await expect(app.page.getByTestId('file-tree-root')).toHaveCount(0);
    await app.page.getByRole('button', { name: 'Window' }).click();
    await app.page.getByRole('button', { name: 'Files' }).click();
    await expect(app.page.getByTestId('file-tree-root')).toBeVisible();
  });

  test('panels are resizable', async ({ app }) => {
    // Dockview uses .dv-sash elements as resize handles
    const sash = app.page.locator('.dv-sash').first();
    await expect(sash).toBeAttached({ timeout: 5000 });
  });
});
