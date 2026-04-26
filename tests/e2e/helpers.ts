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

	// Ensure at least one AI provider is configured so the instance-level gate
	// never blocks tests that don't specifically exercise it.
	await ensureAiProviderConfigured(page, token);

	await page.reload();
}

export async function getToken(page: Page): Promise<string> {
	const tokenRes = await page.request.post('/api/auth/token', {
		data: { master_key: TEST_MASTER_KEY },
	});
	const json = await tokenRes.json();
	return json.data?.token ?? json.token;
}

/** Ensure at least one instance-level AI provider is configured. Idempotent. */
export async function ensureAiProviderConfigured(page: Page, token: string) {
	const headers = { Authorization: `Bearer ${token}` };
	const statusRes = await page.request.get('/api/ai-providers/status', { headers });
	const { data } = await statusRes.json();
	if (data.configured) return;

	await page.request.post('/api/ai-providers', {
		headers: { ...headers, 'Content-Type': 'application/json' },
		data: {
			provider: 'anthropic',
			api_key: 'sk-ant-e2e-test-key',
			label: 'e2e-default',
		},
	});
}

/** Remove every instance-level AI provider config. Used by tests that exercise the gate. */
export async function clearAiProviders(page: Page, token: string) {
	const headers = { Authorization: `Bearer ${token}` };
	const listRes = await page.request.get('/api/ai-providers', { headers });
	const { data } = await listRes.json();
	for (const config of data as Array<{ id: string }>) {
		await page.request.delete(`/api/ai-providers/${config.id}`, { headers });
	}
}

/**
 * Create a project and mark its auto-generated planning issue as done.
 * Tests that kick off agent runs on the CEO would otherwise race the
 * CEO's planning wakeup and see runs targeted at the planning issue.
 */
export async function createProjectAndClearPlanning(
	page: Page,
	companyId: string,
	token: string,
	data: { name: string; description?: string },
) {
	const headers = { Authorization: `Bearer ${token}` };
	const res = await page.request.post(`/api/companies/${companyId}/projects`, {
		headers,
		data,
	});
	const project = (
		(await res.json()) as {
			data: { id: string; slug: string; planning_issue_id: string };
		}
	).data;
	await page.request.patch(`/api/companies/${companyId}/issues/${project.planning_issue_id}`, {
		headers,
		data: { status: 'done' },
	});
	return project;
}

export async function createCompanyWithAgents(page: Page) {
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	await ensureAiProviderConfigured(page, token);

	const typesRes = await page.request.get('/api/company-types', { headers });
	const types = await typesRes.json();
	const typeId = (types as any).data.find((t: any) => t.name === 'Startup')?.id;

	const uid = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: {
			name: `Test Co ${uid}`,
			template_id: typeId,
		},
	});
	const company = ((await companyRes.json()) as any).data;

	return { company, token };
}

/** Dismiss the AI provider setup gate by entering a test API key via the UI. */
export async function dismissAiProviderModal(page: Page) {
	const modal = page.getByText('Set up an AI provider');
	try {
		await modal.waitFor({ state: 'visible', timeout: 15000 });
	} catch {
		return;
	}

	await page.getByRole('button', { name: 'Enter API key' }).first().click();
	await page.locator('input[type="password"]').first().fill('sk-ant-e2e-test-key');
	await page.getByRole('button', { name: 'Save' }).first().click();

	await expect(modal).toBeHidden({ timeout: 20000 });
}

export async function waitForPageLoad(page: Page, timeout = 15000) {
	await expect(page.getByText('Loading...')).toBeHidden({ timeout });
}

export { TEST_MASTER_KEY };
