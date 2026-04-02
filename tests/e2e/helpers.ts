import type { Page } from '@playwright/test';

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

export async function createCompanyWithAgents(page: Page) {
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const typesRes = await page.request.get('/api/company-types', { headers });
	const types = await typesRes.json();
	const typeId = (types as any).data[0]?.id;

	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: {
			name: `Test Co ${Date.now()}`,
			issue_prefix: `TC${Date.now().toString().slice(-4)}`,
			company_type_id: typeId,
		},
	});
	const company = ((await companyRes.json()) as any).data;
	return { company, token };
}

export { TEST_MASTER_KEY };
