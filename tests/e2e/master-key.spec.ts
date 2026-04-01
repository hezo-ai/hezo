import { expect, test } from '@playwright/test';
import { authenticate } from './helpers';

test('loads app when server is pre-unlocked', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible({
		timeout: 10000,
	});
});

test('authenticated user can navigate to companies', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await page.goto('/companies');
	await expect(page.getByRole('button', { name: 'New Company' })).toBeVisible({ timeout: 10000 });
});
