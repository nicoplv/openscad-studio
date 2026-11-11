import { test, expect } from '../../fixtures/app.fixture';

test('fresh startup opens directly to the editor', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-container')).toBeVisible();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await expect(page.getByTestId('welcome-container')).toHaveCount(0);
});
