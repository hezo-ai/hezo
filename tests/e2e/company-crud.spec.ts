import { expect, test } from '@playwright/test';
import { authenticate } from './helpers';

test('can create a company and see agents', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await page.goto('/companies');

	await page.getByRole('button', { name: 'New Company' }).click();
	await page.getByLabel('Name').fill('Test Corp');
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByRole('link', { name: 'Issues' })).toBeVisible({ timeout: 10000 });

	await page.getByRole('link', { name: 'Agents' }).click();
	await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible({
		timeout: 5000,
	});
});
