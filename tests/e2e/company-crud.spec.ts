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
	await expect(startupCard).toBeVisible({ timeout: 15000 });

	// Continue to details step
	await page.getByRole('button', { name: 'Continue' }).click();

	// Fill in company name and create
	await page.getByLabel('Name').fill('Test Corp');
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page).toHaveURL(/\/companies\/[^/]+\/projects\?create=true$/, { timeout: 20000 });

	// Navigate to agents page and verify auto-created agents are visible
	await page.goto(`/companies/${page.url().split('/companies/')[1].split('/')[0]}/agents`);
	await waitForPageLoad(page);

	const main = page.getByRole('main');
	await expect(main.getByRole('link', { name: 'CEO', exact: true })).toBeVisible({
		timeout: 15000,
	});
	await expect(main.getByRole('link', { name: 'Product Lead', exact: true })).toBeVisible({
		timeout: 15000,
	});
	await expect(main.getByRole('link', { name: 'QA Engineer', exact: true })).toBeVisible({
		timeout: 15000,
	});
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

	await expect(page).toHaveURL(/\/companies\/[^/]+\/projects\?create=true$/, { timeout: 20000 });

	// Navigate to agents page and verify CEO and Coach exist
	await page.goto(`/companies/${page.url().split('/companies/')[1].split('/')[0]}/agents`);
	await waitForPageLoad(page);
	const main = page.getByRole('main');
	await expect(main.getByRole('link', { name: 'CEO', exact: true })).toBeVisible({
		timeout: 15000,
	});
	await expect(main.getByRole('link', { name: 'Coach', exact: true })).toBeVisible({
		timeout: 15000,
	});
});

test('post-create redirect lands on projects page with create dialog open', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await suppressAiModal(page);
	await page.goto('/companies/new');

	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByLabel('Name').fill('Auto Create Co');
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page).toHaveURL(/\/companies\/[^/]+\/projects\?create=true$/, { timeout: 20000 });

	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible({ timeout: 15000 });
	await expect(dialog.getByText('Create Project')).toBeVisible();

	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden({ timeout: 15000 });
	await expect(page).toHaveURL(/\/companies\/[^/]+\/projects$/, { timeout: 15000 });
});
