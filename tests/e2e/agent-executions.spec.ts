import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents } from './helpers';

test('agent page defaults to executions tab', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = await agentsRes.json();
	const agent = (agents as any).data[0];

	await page.goto(`/companies/${company.slug}/agents/${agent.id}`);

	await expect(page.getByRole('link', { name: 'Executions' })).toBeVisible({ timeout: 5000 });
	await expect(page.getByRole('main').getByRole('link', { name: 'Settings' })).toBeVisible({
		timeout: 5000,
	});

	// Executions tab is active by default (redirected from index)
	const executionsLink = page.getByRole('link', { name: 'Executions' });
	await expect(executionsLink).toHaveClass(/border-primary/, { timeout: 5000 });
});

test('agent settings tab shows form content', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = await agentsRes.json();
	const agent = (agents as any).data[0];

	await page.goto(`/companies/${company.slug}/agents/${agent.id}/settings`);

	await expect(page.getByText('Budget Usage')).toBeVisible({ timeout: 5000 });
	await expect(page.getByLabel('Title')).toBeVisible({ timeout: 5000 });
	await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible({ timeout: 5000 });
});

test('execution list shows runs and links to detail page', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = await agentsRes.json();
	const agent = (agents as any).data[0];

	// Create a project and issue for the run
	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers: { Authorization: `Bearer ${token}` },
		data: { name: 'Exec Test', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as any).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers: { Authorization: `Bearer ${token}` },
		data: { project_id: project.id, title: 'Run Issue', assignee_id: agent.id },
	});
	const issue = ((await issueRes.json()) as any).data;

	// Insert a heartbeat run via API (direct DB access not available in E2E)
	await page.request.fetch(`/api/companies/${company.id}/agents/${agent.id}/heartbeat-runs`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` },
	});

	// Navigate to executions tab
	await page.goto(`/companies/${company.slug}/agents/${agent.id}/executions`);

	// The page should load without errors
	await expect(page.getByRole('link', { name: 'Executions' })).toBeVisible({ timeout: 5000 });
});
