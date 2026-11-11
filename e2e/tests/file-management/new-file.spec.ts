import { test, expect } from '../../fixtures/app.fixture';

test('New File keeps edited files in the current project', async ({ app }) => {
  await app.setEditorContent('sphere(42);');

  await app.page.getByText('File', { exact: true }).first().click();
  await app.page.getByText('New File', { exact: true }).click();
  await expect(app.page.locator('button[title="new_file.scad"]')).toBeVisible();

  await app.page.locator('button[title="main.scad"]').dblclick();
  await expect.poll(() => app.getEditorContent()).toBe('sphere(42);');
});

test('New Project can cancel or discard unsaved changes', async ({ app }) => {
  await app.setEditorContent('sphere(42);');
  const newProject = async () => {
    await app.page.getByText('File', { exact: true }).first().click();
    await app.page.getByText('New Project', { exact: true }).click();
    return app.page.getByRole('dialog', { name: 'Save changes to this project?' });
  };
  await (await newProject()).getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => app.getEditorContent()).toBe('sphere(42);');

  await (await newProject()).getByRole('button', { name: 'Discard' }).click();
  await expect.poll(() => app.getEditorContent()).toContain('cube([10, 10, 10]);');
});
