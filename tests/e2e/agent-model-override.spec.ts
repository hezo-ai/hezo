import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents } from './helpers';

test('agent model override round-trips via API', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as any).data;
	const engineer = agents.find((a: any) => a.slug === 'engineer');
	expect(engineer).toBeDefined();

	expect(engineer.model_override_provider).toBeNull();
	expect(engineer.model_override_model).toBeNull();

	const setRes = await page.request.patch(`/api/companies/${company.id}/agents/${engineer.id}`, {
		headers: { ...headers, 'Content-Type': 'application/json' },
		data: {
			model_override_provider: 'anthropic',
			model_override_model: 'claude-haiku-4-5',
		},
	});
	expect(setRes.status()).toBe(200);
	const setBody = await setRes.json();
	expect(setBody.data.model_override_provider).toBe('anthropic');
	expect(setBody.data.model_override_model).toBe('claude-haiku-4-5');

	const clearRes = await page.request.patch(`/api/companies/${company.id}/agents/${engineer.id}`, {
		headers: { ...headers, 'Content-Type': 'application/json' },
		data: { model_override_provider: null },
	});
	expect(clearRes.status()).toBe(200);
	const clearBody = await clearRes.json();
	expect(clearBody.data.model_override_provider).toBeNull();
	expect(clearBody.data.model_override_model).toBeNull();
});

test('agent settings page shows model override selects and persists choice', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as any).data;
	const researcher = agents.find((a: any) => a.slug === 'researcher');

	await page.goto(`/companies/${company.id}/agents/${researcher.id}/settings`);

	const providerSelect = page.getByLabel('Model override provider');
	await expect(providerSelect).toBeVisible({ timeout: 5000 });
	await providerSelect.selectOption('anthropic');

	const modelSelect = page.getByLabel('Model override model');
	await expect(modelSelect).toBeVisible();

	// Write directly via API since the dropdown depends on a live provider call.
	await page.request.patch(`/api/companies/${company.id}/agents/${researcher.id}`, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: {
			model_override_provider: 'anthropic',
			model_override_model: 'claude-opus-4-7',
		},
	});

	await page.reload();
	await expect(providerSelect).toHaveValue('anthropic');
	await expect(modelSelect).toHaveValue('claude-opus-4-7');
});
