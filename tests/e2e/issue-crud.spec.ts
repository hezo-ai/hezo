import { expect, test } from '@playwright/test';
import { authenticate } from './helpers';

test('can create an issue', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await page.goto('/companies');

	await page.getByRole('button', { name: 'New Company' }).click();
	await page.getByLabel('Name').fill('Issue Test Corp');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByText('Issues')).toBeVisible({ timeout: 10000 });

	// Create a project first
	await page.getByText('Projects').click();
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByLabel('Name').fill('Test Project');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByText('Test Project')).toBeVisible({ timeout: 5000 });

	// Create issue
	await page.getByText('Issues').click();
	await page.getByRole('button', { name: 'New Issue' }).click();
	await page.getByLabel('Title').fill('Test Issue');
	await page
		.locator('select')
		.filter({ hasText: 'Select project' })
		.selectOption({ label: 'Test Project' });
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByText('Test Issue')).toBeVisible({ timeout: 10000 });
});
