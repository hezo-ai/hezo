import { expect, test } from '@playwright/test';
import { authenticate } from './helpers';

test('can create a company with default team type and see auto-created agents', async ({
	page,
}) => {
	await page.goto('/');
	await authenticate(page);
	await page.goto('/companies');

	await page
		.getByRole('button', { name: 'New company' })
		.filter({ hasText: 'New company' })
		.click();
	await page.getByLabel('Name').fill('Test Corp');

	// "Software Development" should be checked by default
	const softDevCheckbox = page.getByLabel('Software Development');
	await expect(softDevCheckbox).toBeChecked();

	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByRole('link', { name: 'Issues' })).toBeVisible({ timeout: 10000 });

	// Navigate to agents and verify auto-created agents are visible
	await page.getByRole('link', { name: 'Agents' }).click();
	await expect(page.getByRole('link', { name: 'Agents', exact: true })).toBeVisible({
		timeout: 5000,
	});

	// Verify agents were auto-created from the team type
	await expect(page.getByText('CEO')).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('Product Lead')).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('QA Engineer')).toBeVisible({ timeout: 5000 });
});

test('create company dialog shows Team Types label', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await page.goto('/companies');

	await page
		.getByRole('button', { name: 'New company' })
		.filter({ hasText: 'New company' })
		.click();

	await expect(page.getByText('Team Types')).toBeVisible();
});
