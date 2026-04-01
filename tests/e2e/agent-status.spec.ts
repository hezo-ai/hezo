import { expect, type Page, test } from '@playwright/test';
import { authenticate } from './helpers';

async function createCompanyWithAgents(page: Page) {
	// Get company type ID and create company via API so agents are auto-created
	const typesRes = await page.request.get('/api/company-types', {
		headers: { Authorization: `Bearer ${await getToken(page)}` },
	});
	const types = await typesRes.json();
	const typeId = types.data[0]?.id;

	const companyRes = await page.request.post('/api/companies', {
		headers: { Authorization: `Bearer ${await getToken(page)}` },
		data: {
			name: `Test Co ${Date.now()}`,
			issue_prefix: `TC${Date.now().toString().slice(-4)}`,
			company_type_id: typeId,
		},
	});
	const company = await companyRes.json();
	return company.data;
}

async function getToken(page: Page): Promise<string> {
	const tokenRes = await page.request.post('/api/auth/token', {
		data: { master_key: 'e2e-test-master-key-0123456789abcdef0123456789abcdef' },
	});
	const json = await tokenRes.json();
	return json.data?.token ?? json.token;
}

test('agent list shows status badges and budget bars', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const company = await createCompanyWithAgents(page);
	await page.goto(`/companies/${company.id}/agents`);

	// Verify agents heading
	await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible({
		timeout: 5000,
	});

	// Verify status badges render (active/idle)
	await expect(page.getByText('active').or(page.getByText('idle')).first()).toBeVisible({
		timeout: 5000,
	});

	// Verify budget display ($ amounts visible)
	await expect(page.getByText(/\$\d+\.\d+/).first()).toBeVisible({ timeout: 5000 });
});

test('agent detail page shows budget and heartbeat info', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const company = await createCompanyWithAgents(page);

	// Get agents list via API
	const token = await getToken(page);
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = await agentsRes.json();
	const firstAgent = agents.data[0];

	await page.goto(`/companies/${company.id}/agents/${firstAgent.id}`);

	// Verify budget usage section
	await expect(page.getByText('Budget Usage')).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('Heartbeat').first()).toBeVisible({ timeout: 5000 });
});

test('project detail shows container section with rebuild button', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const company = await createCompanyWithAgents(page);

	// Create project via API
	const token = await getToken(page);
	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers: { Authorization: `Bearer ${token}` },
		data: { name: 'Container Test Project' },
	});
	const project = await projectRes.json();

	await page.goto(`/companies/${company.id}/projects/${project.data.id}`);

	// Verify container section with rebuild button
	await expect(page.getByRole('button', { name: /Rebuild/i })).toBeVisible({ timeout: 5000 });
});
