import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test('team page shows org chart with status legend', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompanyWithAgents(page);
	await page.goto(`/companies/${company.slug}/agents`);

	await expect(page.getByRole('link', { name: 'Team', exact: true })).toBeVisible({
		timeout: 5000,
	});

	await expect(page.getByText('You (Board)')).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('Idle').first()).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('Active').first()).toBeVisible({ timeout: 5000 });
});

test('agent detail page shows budget and heartbeat info', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = await agentsRes.json();
	const firstAgent = (agents as any).data[0];

	await page.goto(`/companies/${company.slug}/agents/${firstAgent.id}`);

	await expect(page.getByText('Budget Usage')).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('Heartbeat').first()).toBeVisible({ timeout: 5000 });
});

test('project detail shows container section with rebuild button', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers: { Authorization: `Bearer ${token}` },
		data: { name: 'Container Test Project' },
	});
	const project = await projectRes.json();

	await page.goto(`/companies/${company.slug}/projects/${(project as any).data.slug}/container`);

	await expect(page.getByRole('button', { name: /Rebuild/i })).toBeVisible({ timeout: 5000 });
});

test('agent detail page allows editing title', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = await agentsRes.json();
	const agent = (agents as any).data.find((a: any) => a.admin_status === 'enabled');

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

	const { company, token } = await createCompanyWithAgents(page);
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = await agentsRes.json();
	const enabledAgent = (agents as any).data.find((a: any) => a.admin_status === 'enabled');

	await page.goto(`/companies/${company.slug}/agents/${enabledAgent.id}`);
	await waitForPageLoad(page);

	const disableBtn = page.getByRole('button', { name: /Disable/i });
	await expect(disableBtn).toBeVisible({ timeout: 10000 });
	await disableBtn.click();

	await expect(page.getByText('(disabled)')).toBeVisible({ timeout: 5000 });

	const enableBtn = page.getByRole('button', { name: /Enable/i });
	await expect(enableBtn).toBeVisible({ timeout: 5000 });
	await enableBtn.click();

	await expect(page.getByText('(disabled)')).not.toBeVisible({ timeout: 5000 });
	await expect(page.getByText('Idle')).toBeVisible({ timeout: 5000 });
});

test('disabled agent shows on team org chart and detail page', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = await agentsRes.json();
	const enabledAgent = (agents as any).data.find((a: any) => a.admin_status === 'enabled');

	await page.request.post(`/api/companies/${company.id}/agents/${enabledAgent.id}/disable`, {
		headers: { Authorization: `Bearer ${token}` },
	});

	await page.goto(`/companies/${company.slug}/agents`);
	await expect(page.getByText('You (Board)')).toBeVisible({ timeout: 5000 });

	await page.goto(`/companies/${company.slug}/agents/${enabledAgent.id}`);
	await expect(page.getByText('(disabled)')).toBeVisible({ timeout: 5000 });
});
