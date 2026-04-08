import { expect, type Page } from '@playwright/test';

const TEST_MASTER_KEY = 'e2e-test-master-key-0123456789abcdef0123456789abcdef';

export async function authenticate(page: Page) {
	const res = await page.request.post('/api/auth/token', {
		data: { master_key: TEST_MASTER_KEY },
	});
	const json = await res.json();
	const token = json.data?.token ?? json.token;

	await page.addInitScript((t: string) => {
		localStorage.setItem('hezo_token', t);
	}, token);

	await page.reload();
}

export async function getToken(page: Page): Promise<string> {
	const tokenRes = await page.request.post('/api/auth/token', {
		data: { master_key: TEST_MASTER_KEY },
	});
	const json = await tokenRes.json();
	return json.data?.token ?? json.token;
}

/** Configure a default AI provider for a company so the blocking setup modal doesn't appear. */
export async function configureAiProvider(
	page: Page,
	companyId: string,
	headers: Record<string, string>,
) {
	await page.request.post(`/api/companies/${companyId}/ai-providers`, {
		headers: { ...headers, 'Content-Type': 'application/json' },
		data: { provider: 'anthropic', api_key: 'sk-ant-e2e-test-key' },
	});
}

export async function createCompanyWithAgents(page: Page) {
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const typesRes = await page.request.get('/api/company-types', { headers });
	const types = await typesRes.json();
	const typeId = (types as any).data.find((t: any) => t.name === 'Startup')?.id;

	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: {
			name: `Test Co ${Date.now()}`,
			issue_prefix: `TC${Date.now().toString().slice(-4)}`,
			template_id: typeId,
		},
	});
	const company = ((await companyRes.json()) as any).data;

	await configureAiProvider(page, company.id, headers);

	return { company, token };
}

/** Dismiss the AI provider setup modal by entering a test API key via the UI. */
export async function dismissAiProviderModal(page: Page) {
	const modal = page.getByText('Set up an AI provider');
	try {
		await modal.waitFor({ state: 'visible', timeout: 5000 });
	} catch {
		return;
	}

	await page.getByRole('button', { name: 'Enter API key' }).first().click();
	await page.locator('input[type="password"]').first().fill('sk-ant-e2e-test-key');
	await page.getByRole('button', { name: 'Save' }).first().click();

	await expect(modal).toBeHidden({ timeout: 10000 });
}

export async function waitForPageLoad(page: Page, timeout = 15000) {
	await expect(page.getByText('Loading...')).toBeHidden({ timeout });
}

export { TEST_MASTER_KEY };
