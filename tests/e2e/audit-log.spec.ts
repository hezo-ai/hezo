import { expect, type Page, test } from '@playwright/test';
import { authenticate, TEST_MASTER_KEY } from './helpers';

async function getToken(page: Page): Promise<string> {
	const tokenRes = await page.request.post('/api/auth/token', {
		data: { master_key: TEST_MASTER_KEY },
	});
	const json = await tokenRes.json();
	return json.data?.token ?? json.token;
}

test('audit log section renders on settings page', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	// Create a company
	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: {
			name: `Audit Test ${Date.now()}`,
			issue_prefix: `AU${Date.now().toString().slice(-4)}`,
		},
	});
	const company = (await companyRes.json()).data;

	// Navigate to settings page
	await page.goto(`/companies/${company.id}/settings`);

	// Verify the Audit Log section heading is visible
	await expect(page.getByText('Audit Log')).toBeVisible({ timeout: 10000 });
});
