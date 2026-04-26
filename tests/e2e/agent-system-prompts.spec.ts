import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, getToken } from './helpers';

test('agents created from company type have system prompts via API', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as any).data;

	expect(agents.length).toBe(11);

	const getPrompt = async (agentId: string): Promise<string> => {
		const res = await page.request.get(
			`/api/companies/${company.id}/agents/${agentId}/system-prompt`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		return (((await res.json()) as any).data?.content ?? '') as string;
	};

	for (const agent of agents) {
		const prompt = await getPrompt(agent.id);
		expect(prompt).toBeTruthy();
		expect(prompt.length).toBeGreaterThan(100);
	}

	const ceo = agents.find((a: any) => a.slug === 'ceo');
	const ceoPrompt = await getPrompt(ceo.id);
	expect(ceoPrompt).toContain('You are the CEO of');
	expect(ceoPrompt).toContain('{{company_name}}');
	expect(ceoPrompt).toMatch(/##\s+Rules\b/);

	const engineer = agents.find((a: any) => a.slug === 'engineer');
	const engineerPrompt = await getPrompt(engineer.id);
	expect(engineerPrompt).toContain('You are an Engineer at');
	expect(engineerPrompt).toContain('{{reports_to}}');
});

test('system prompt revisions panel lists history after an edit', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as any).data;
	const engineer = agents.find((a: any) => a.slug === 'engineer');

	await page.goto(`/companies/${company.id}/agents/${engineer.id}/settings`);

	const promptTextarea = page.getByLabel('System Prompt');
	await expect(promptTextarea).toBeVisible({ timeout: 15000 });

	const original = await promptTextarea.inputValue();
	await promptTextarea.fill(`${original}\n- New rule added by e2e test`);
	await page.getByRole('button', { name: 'Save Changes' }).click();

	await page.reload();
	await expect(page.getByLabel('System Prompt')).toBeVisible({ timeout: 15000 });
	await page.getByRole('button', { name: /Show revision history/i }).click();
	await expect(page.getByText(/Rev \d+/)).toBeVisible();
});

test('agent detail page displays system prompt in textarea', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as any).data;
	const engineer = agents.find((a: any) => a.slug === 'engineer');

	await page.goto(`/companies/${company.id}/agents/${engineer.id}/settings`);

	const promptTextarea = page.getByLabel('System Prompt');
	await expect(promptTextarea).toBeVisible({ timeout: 15000 });

	const promptValue = await promptTextarea.inputValue();
	expect(promptValue).toContain('You are an Engineer at');
	expect(promptValue).toContain('{{company_name}}');
	expect(promptValue).toMatch(/##\s+Rules\b/);
});

test('system prompt can be edited and saved', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as any).data;
	const researcher = agents.find((a: any) => a.slug === 'researcher');

	await page.goto(`/companies/${company.id}/agents/${researcher.id}/settings`);

	const promptTextarea = page.getByLabel('System Prompt');
	await expect(promptTextarea).toBeVisible({ timeout: 15000 });

	const originalValue = await promptTextarea.inputValue();
	const updatedPrompt = `${originalValue}\n- Always respond in formal English`;
	await promptTextarea.fill(updatedPrompt);

	await page.getByRole('button', { name: 'Save Changes' }).click();

	await page.reload();
	await expect(promptTextarea).toBeVisible({ timeout: 15000 });
	const savedValue = await promptTextarea.inputValue();
	expect(savedValue).toContain('Always respond in formal English');
	expect(savedValue).toContain('You are the Researcher at');
});

test('company type seed data includes system prompts for all 11 agents', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const token = await getToken(page);

	const typesRes = await page.request.get('/api/company-types', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const types = ((await typesRes.json()) as any).data;
	const softDev = types.find((t: any) => t.name === 'Startup');
	expect(softDev).toBeTruthy();

	const agentsConfig = softDev.agent_types;
	expect(agentsConfig).toHaveLength(11);

	const expectedSlugs = [
		'ceo',
		'architect',
		'product-lead',
		'engineer',
		'qa-engineer',
		'ui-designer',
		'devops-engineer',
		'marketing-lead',
		'researcher',
		'security-engineer',
		'coach',
	];
	for (const slug of expectedSlugs) {
		const agent = agentsConfig.find((a: any) => a.slug === slug);
		expect(agent, `Agent ${slug} should exist in config`).toBeTruthy();
		expect(agent.system_prompt, `Agent ${slug} should have a system_prompt`).toBeTruthy();
		expect(
			agent.system_prompt.length,
			`Agent ${slug} system_prompt should be substantial`,
		).toBeGreaterThan(100);
	}
});
