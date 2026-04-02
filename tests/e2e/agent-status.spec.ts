import { expect, type Page, test } from '@playwright/test';
import { authenticate } from './helpers';

async function createCompanyWithAgents(page: Page) {
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
	await page.goto(`/companies/${company.slug}/agents`);

	await expect(page.getByRole('link', { name: 'Agents', exact: true })).toBeVisible({
		timeout: 5000,
	});

	await expect(page.getByText('Enabled').first()).toBeVisible({ timeout: 5000 });
	await expect(page.getByText(/\$\d+/).first()).toBeVisible({ timeout: 5000 });
});

test('agent detail page shows budget and heartbeat info', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const company = await createCompanyWithAgents(page);

	const token = await getToken(page);
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = await agentsRes.json();
	const firstAgent = agents.data[0];

	await page.goto(`/companies/${company.slug}/agents/${firstAgent.id}`);

	await expect(page.getByText('Budget Usage')).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('Heartbeat').first()).toBeVisible({ timeout: 5000 });
});

test('project detail shows container section with rebuild button', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const company = await createCompanyWithAgents(page);

	const token = await getToken(page);
	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers: { Authorization: `Bearer ${token}` },
		data: { name: 'Container Test Project' },
	});
	const project = await projectRes.json();

	await page.goto(`/companies/${company.slug}/projects/${project.data.slug}`);

	await expect(page.getByRole('button', { name: /Rebuild/i })).toBeVisible({ timeout: 5000 });
});

test('agent detail page allows editing title', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const company = await createCompanyWithAgents(page);
	const token = await getToken(page);
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = await agentsRes.json();
	const agent = agents.data.find((a: any) => a.admin_status === 'enabled');

	await page.goto(`/companies/${company.slug}/agents/${agent.id}`);

	const titleInput = page.getByLabel('Title');
	await expect(titleInput).toBeVisible({ timeout: 5000 });
	await titleInput.fill(`${agent.title} Updated`);

	await page.getByRole('button', { name: 'Save Changes' }).click();

	await expect(page.getByText(`${agent.title} Updated`).first()).toBeVisible({ timeout: 5000 });
});

test('agent disable and enable lifecycle', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const company = await createCompanyWithAgents(page);
	const token = await getToken(page);
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = await agentsRes.json();
	const enabledAgent = agents.data.find((a: any) => a.admin_status === 'enabled');

	await page.goto(`/companies/${company.slug}/agents/${enabledAgent.id}`);

	const disableBtn = page.getByRole('button', { name: /Disable/i });
	await expect(disableBtn).toBeVisible({ timeout: 5000 });
	await disableBtn.click();

	await expect(page.getByText('disabled')).toBeVisible({ timeout: 5000 });

	const enableBtn = page.getByRole('button', { name: /Enable/i });
	await expect(enableBtn).toBeVisible({ timeout: 5000 });
	await enableBtn.click();

	await expect(page.getByText('enabled')).toBeVisible({ timeout: 5000 });
});
