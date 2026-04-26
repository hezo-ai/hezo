import { expect, test } from '@playwright/test';
import { authenticate } from './helpers';

test('loads app when server is pre-unlocked', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await page.waitForURL('**/companies', { timeout: 30000 });
	await expect(
		page
			.getByRole('heading', { name: 'Companies', exact: true })
			.or(page.getByRole('heading', { name: 'Welcome to Hezo' })),
	).toBeVisible({ timeout: 20000 });
});

test('authenticated user can navigate to companies', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await page.goto('/companies');
	await expect(page.getByText('New company')).toBeVisible({ timeout: 20000 });
});
