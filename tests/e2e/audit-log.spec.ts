import { expect, type Page, test } from '@playwright/test';
import { authenticate, configureAiProvider, TEST_MASTER_KEY } from './helpers';

async function getToken(page: Page): Promise<string> {
	const tokenRes = await page.request.post('/api/auth/token', {
		data: { master_key: TEST_MASTER_KEY },
	});
	const json = await tokenRes.json();
	return json.data?.token ?? json.token;
}

async function createCompany(page: Page, token: string) {
	const headers = { Authorization: `Bearer ${token}` };
	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: {
			name: `Audit Test ${Date.now()}`,
			issue_prefix: `AU${Date.now().toString().slice(-4)}`,
		},
	});
	const company = (await companyRes.json()).data;
	await configureAiProvider(page, company.id, headers);
	return company;
}

test('audit log page renders at dedicated route', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	const token = await getToken(page);
	const company = await createCompany(page, token);

	await page.goto(`/companies/${company.id}/audit-log`);
	await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible({ timeout: 10000 });
});

test('sidebar contains audit log link', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	const token = await getToken(page);
	const company = await createCompany(page, token);

	await page.goto(`/companies/${company.id}/issues`);
	const auditLink = page.getByRole('link', { name: 'Audit log' });
	await expect(auditLink).toBeVisible({ timeout: 10000 });
});

test('settings page does not contain audit log section', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	const token = await getToken(page);
	const company = await createCompany(page, token);

	await page.goto(`/companies/${company.id}/settings`);
	await expect(page.getByRole('heading', { name: 'General' })).toBeVisible({ timeout: 10000 });
	await expect(page.getByRole('heading', { name: 'Audit log' })).not.toBeVisible();
});
