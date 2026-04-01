import { expect, test } from '@playwright/test';
import { authenticate } from './helpers';

test('can create an issue', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await page.goto('/companies');

	await page.getByRole('button', { name: 'New Company' }).click();
	await page.getByLabel('Name').fill('Issue Test Corp');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('link', { name: 'Issues' })).toBeVisible({ timeout: 10000 });

	// Create a project first
	await page.getByRole('link', { name: 'Projects' }).click();
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByLabel('Name').fill('Test Project');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByText('Test Project')).toBeVisible({ timeout: 5000 });

	// Create issue
	await page.getByRole('link', { name: 'Issues', exact: true }).click();
	await expect(page.getByRole('button', { name: 'New Issue' }).first()).toBeVisible({
		timeout: 10000,
	});
	await page.getByRole('button', { name: 'New Issue' }).first().click();
	await page.getByLabel('Title').fill('Test Issue');
	await page
		.locator('select')
		.filter({ hasText: 'Select project' })
		.selectOption({ label: 'Test Project' });
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByText('Test Issue')).toBeVisible({ timeout: 10000 });
});
