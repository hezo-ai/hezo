import { expect, type Page, test } from '@playwright/test';
import { authenticate, TEST_MASTER_KEY } from './helpers';

async function getToken(page: Page): Promise<string> {
	const tokenRes = await page.request.post('/api/auth/token', {
		data: { master_key: TEST_MASTER_KEY },
	});
	const json = await tokenRes.json();
	return json.data?.token ?? json.token;
}

async function createCompanyWithAgents(page: Page) {
	const token = await getToken(page);

	const typesRes = await page.request.get('/api/company-types', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const types = await typesRes.json();
	const typeId = (types as any).data[0]?.id;

	const companyRes = await page.request.post('/api/companies', {
		headers: { Authorization: `Bearer ${token}` },
		data: {
			name: `Prompt Co ${Date.now()}`,
			issue_prefix: `PC${Date.now().toString().slice(-4)}`,
			description: 'Build the future',
			company_type_id: typeId,
		},
	});
	return { company: ((await companyRes.json()) as any).data, token };
}

test('agents created from company type have system prompts via API', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as any).data;

	expect(agents.length).toBe(9);

	for (const agent of agents) {
		expect(agent.system_prompt).toBeTruthy();
		expect(agent.system_prompt.length).toBeGreaterThan(100);
	}

	const ceo = agents.find((a: any) => a.slug === 'ceo');
	expect(ceo.system_prompt).toContain('You are the CEO of');
	expect(ceo.system_prompt).toContain('{{company_name}}');
	expect(ceo.system_prompt).toContain('Rules:');

	const engineer = agents.find((a: any) => a.slug === 'engineer');
	expect(engineer.system_prompt).toContain('You are an Engineer at');
	expect(engineer.system_prompt).toContain('{{reports_to}}');
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

	await page.goto(`/companies/${company.id}/agents/${engineer.id}`);

	// The system prompt textarea should contain the template content
	const promptTextarea = page.getByLabel('System Prompt');
	await expect(promptTextarea).toBeVisible({ timeout: 5000 });

	const promptValue = await promptTextarea.inputValue();
	expect(promptValue).toContain('You are an Engineer at');
	expect(promptValue).toContain('{{company_name}}');
	expect(promptValue).toContain('Rules:');
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

	await page.goto(`/companies/${company.id}/agents/${researcher.id}`);

	const promptTextarea = page.getByLabel('System Prompt');
	await expect(promptTextarea).toBeVisible({ timeout: 5000 });

	// Append custom instruction to the prompt
	const originalValue = await promptTextarea.inputValue();
	const updatedPrompt = `${originalValue}\n- Always respond in formal English`;
	await promptTextarea.fill(updatedPrompt);

	await page.getByRole('button', { name: 'Save Changes' }).click();

	// Reload and verify persistence
	await page.reload();
	await expect(promptTextarea).toBeVisible({ timeout: 5000 });
	const savedValue = await promptTextarea.inputValue();
	expect(savedValue).toContain('Always respond in formal English');
	expect(savedValue).toContain('You are the Researcher at');
});

test('company type seed data includes system prompts for all 9 agents', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const token = await getToken(page);

	// Verify the company type itself stores the system prompts in agents_config
	const typesRes = await page.request.get('/api/company-types', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const types = ((await typesRes.json()) as any).data;
	const softDev = types.find((t: any) => t.name === 'Software Development');
	expect(softDev).toBeTruthy();

	const agentsConfig = softDev.agent_types;
	expect(agentsConfig).toHaveLength(9);

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
