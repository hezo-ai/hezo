import { expect, type Page, test } from '@playwright/test';
import { authenticate, waitForPageLoad } from './helpers';

async function suppressAiModal(page: Page) {
	await page.route('**/ai-providers/status', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: { configured: true } }),
		}),
	);
}

test('can create a company with Startup template and see auto-created agents', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await suppressAiModal(page);
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

	// Navigate to agents page and verify auto-created agents are visible
	await page.goto(`/companies/${page.url().split('/companies/')[1].split('/')[0]}/agents`);
	await waitForPageLoad(page);

	const main = page.getByRole('main');
	await expect(main.getByText('CEO')).toBeVisible({ timeout: 5000 });
	await expect(main.getByText('Product Lead')).toBeVisible({ timeout: 5000 });
	await expect(main.getByText('QA Engineer')).toBeVisible({ timeout: 5000 });
});

test('new company page shows template selection', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await page.goto('/companies/new');

	await expect(page.getByText('Choose a template')).toBeVisible();
	await expect(page.getByText('Startup')).toBeVisible();
	await expect(page.getByText('Blank')).toBeVisible();
});

test('Blank template shows built-in agents note and creates CEO/Coach', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await suppressAiModal(page);
	await page.goto('/companies/new');

	// Select Blank template
	const blankCard = page.locator('button', { hasText: 'Blank' });
	await blankCard.click();

	// Verify the built-in agents badge is visible on the Blank card
	await expect(blankCard.getByText('Includes CEO + Coach')).toBeVisible();

	// Continue to details step
	await page.getByRole('button', { name: 'Continue' }).click();

	// Fill in company name and create
	await page.getByLabel('Name').fill('Blank Test Co');
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByRole('link', { name: 'Issues' })).toBeVisible({ timeout: 10000 });

	// Navigate to agents page and verify CEO and Coach exist
	await page.goto(`/companies/${page.url().split('/companies/')[1].split('/')[0]}/agents`);
	await waitForPageLoad(page);
	const main = page.getByRole('main');
	await expect(main.getByText('CEO')).toBeVisible({ timeout: 5000 });
	await expect(main.getByText('Coach')).toBeVisible({ timeout: 5000 });
});
