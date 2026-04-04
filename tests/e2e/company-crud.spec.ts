import { expect, test } from '@playwright/test';
import { authenticate } from './helpers';

test('can create a company with Startup template and see auto-created agents', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await page.goto('/companies/new');

	// Startup template should be selected by default
	const startupCard = page.getByText('Startup').first();
	await expect(startupCard).toBeVisible({ timeout: 5000 });

	// Continue to details step
	await page.getByRole('button', { name: 'Continue' }).click();

	// Fill in company name and create
	await page.getByLabel('Name').fill('Test Corp');
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByRole('link', { name: 'Issues' })).toBeVisible({ timeout: 10000 });

	// Navigate to agents and verify auto-created agents are visible
	await page.getByRole('link', { name: 'Agents' }).click();
	await expect(page.getByRole('link', { name: 'Agents', exact: true })).toBeVisible({
		timeout: 5000,
	});

	await expect(page.getByText('CEO')).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('Product Lead')).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('QA Engineer')).toBeVisible({ timeout: 5000 });
});

test('new company page shows template selection', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await page.goto('/companies/new');

	await expect(page.getByText('Choose a template')).toBeVisible();
	await expect(page.getByText('Startup')).toBeVisible();
	await expect(page.getByText('Blank')).toBeVisible();
});
