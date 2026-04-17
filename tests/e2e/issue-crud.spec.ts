import { expect, type Page, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, getToken, waitForPageLoad } from './helpers';

async function suppressAiModal(page: Page) {
	await page.route('**/ai-providers/status', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: { configured: true } }),
		}),
	);
}

test('can create an issue with required assignee', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	// Get agents for assignee selection
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string }[];
	expect(agents.length).toBeGreaterThan(0);
	const agent = agents[0];

	// Create a project via API
	await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Test Project' },
	});

	// Navigate to issues
	await suppressAiModal(page);
	await page.goto(`/companies/${company.slug}/issues`);
	await waitForPageLoad(page);
	await expect(page.getByRole('button', { name: 'New Issue' }).first()).toBeVisible({
		timeout: 10000,
	});
	await page.getByRole('button', { name: 'New Issue' }).first().click();
	await page.getByLabel('Title').fill('Test Issue');
	await page
		.locator('select')
		.filter({ hasText: 'Select project' })
		.selectOption({ label: 'Test Project' });

	// Verify Create button is disabled without assignee
	await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();

	// Select assignee
	await page
		.locator('select')
		.filter({ hasText: 'Select assignee' })
		.selectOption({ label: agent.title });

	// Now Create button should be enabled
	await expect(page.getByRole('button', { name: 'Create' })).toBeEnabled();
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByText('Test Issue')).toBeVisible({ timeout: 10000 });
});

test('issue detail shows execution lock banner when locked', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	// Create company with agents (need agent for lock)
	const typesRes = await page.request.get('/api/company-types', { headers });
	const types = (await typesRes.json()).data as { id: string; name: string }[];
	const typeId = types.find((t) => t.name === 'Startup')?.id;

	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: {
			name: `Lock Test ${Date.now()}`,
			issue_prefix: `LK${Date.now().toString().slice(-4)}`,
			template_id: typeId,
		},
	});
	const company = (await companyRes.json()).data;

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Lock Project' },
	});
	const project = (await projectRes.json()).data;

	// Get an agent for assignee and lock
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	expect(agentsRes.ok()).toBeTruthy();
	const agents = (await agentsRes.json()).data;
	expect(agents.length).toBeGreaterThan(0);
	const agent = agents[0];

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Locked Issue', assignee_id: agent.id },
	});
	const issue = (await issueRes.json()).data;

	// Acquire the execution lock
	const lockRes = await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/lock`, {
		headers,
		data: { member_id: agent.id },
	});
	expect(lockRes.ok()).toBeTruthy();

	await page.goto(`/companies/${company.id}/issues/${issue.id}`);
	await waitForPageLoad(page);

	await expect(page.getByText('is working on this issue')).toBeVisible({ timeout: 15000 });
});

test('can edit issue rules and progress summary', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string }[];
	const agent = agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Rules Project' },
	});
	const project = (await projectRes.json()).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Rules Test Issue', assignee_id: agent.id },
	});
	const issue = (await issueRes.json()).data;

	await page.goto(`/companies/${company.id}/issues/${issue.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Rules Test Issue' })).toBeVisible({
		timeout: 10000,
	});

	// Edit rules
	const rulesSection = page.getByText('Rules', { exact: true }).locator('..').locator('..');
	await rulesSection.getByText('Edit').click();
	await rulesSection.locator('textarea').fill('Consult architect before changes');
	await rulesSection.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Consult architect before changes')).toBeVisible({ timeout: 5000 });

	// Edit progress summary
	const summarySection = page
		.getByText('Progress Summary', { exact: true })
		.locator('..')
		.locator('..');
	await summarySection.getByText('Edit').click();
	await summarySection.locator('textarea').fill('Implementation started');
	await summarySection.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Implementation started')).toBeVisible({ timeout: 5000 });

	// Verify persistence after reload
	await page.reload();
	await waitForPageLoad(page);
	await expect(page.getByText('Consult architect before changes')).toBeVisible({ timeout: 15000 });
	await expect(page.getByText('Implementation started')).toBeVisible({ timeout: 15000 });
});

test('issue detail shows assignee with status badge', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	// Get agents
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string }[];
	expect(agents.length).toBeGreaterThan(0);
	const agent = agents[0];

	// Create project and issue assigned to agent
	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Assignee Project' },
	});
	const project = (await projectRes.json()).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Assignee Badge Issue', assignee_id: agent.id },
	});
	const issue = (await issueRes.json()).data;

	await page.goto(`/companies/${company.id}/issues/${issue.id}`);
	await waitForPageLoad(page);

	// Verify agent name is displayed in the sidebar
	const sidebar = page.locator('.grid > div:last-child');
	await expect(sidebar.getByText(agent.title)).toBeVisible({ timeout: 10000 });

	// Verify a status badge (Idle/Running/Paused) is shown
	await expect(
		sidebar.getByText('Idle').or(sidebar.getByText('Running')).or(sidebar.getByText('Paused')),
	).toBeVisible();

	// Verify chevron button exists
	await expect(sidebar.locator('button svg.lucide-chevron-down')).toBeVisible();
});

test('can change assignee via popover dropdown', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string }[];
	expect(agents.length).toBeGreaterThanOrEqual(2);
	const agent1 = agents[0];
	const agent2 = agents[1];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Change Assignee Project' },
	});
	const project = (await projectRes.json()).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Change Assignee Issue', assignee_id: agent1.id },
	});
	const issue = (await issueRes.json()).data;

	await page.goto(`/companies/${company.id}/issues/${issue.id}`);
	await waitForPageLoad(page);

	const sidebar = page.locator('.grid > div:last-child');
	await expect(sidebar.getByText(agent1.title)).toBeVisible({ timeout: 10000 });

	// Click the assignee button to open dropdown
	await sidebar.locator('button', { has: page.locator('svg.lucide-chevron-down') }).click();

	// Dropdown should appear with agents
	const dropdown = sidebar.locator('.absolute');
	await expect(dropdown).toBeVisible();
	await expect(dropdown.getByText(agent2.title)).toBeVisible();

	// Select a different agent
	await dropdown.locator('button', { hasText: agent2.title }).click();

	// Dropdown should close and new assignee should be shown
	await expect(dropdown).toBeHidden();
	await expect(sidebar.getByText(agent2.title)).toBeVisible({ timeout: 10000 });
});

test('assignee dropdown closes on outside click and has no unassign option', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string }[];
	const agent = agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Outside Click Project' },
	});
	const project = (await projectRes.json()).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Outside Click Issue', assignee_id: agent.id },
	});
	const issue = (await issueRes.json()).data;

	await page.goto(`/companies/${company.id}/issues/${issue.id}`);
	await waitForPageLoad(page);

	const sidebar = page.locator('.grid > div:last-child');

	// Open dropdown
	await sidebar.locator('button', { has: page.locator('svg.lucide-chevron-down') }).click();
	const dropdown = sidebar.locator('.absolute');
	await expect(dropdown).toBeVisible();

	// Verify no "Unassigned" option exists in the dropdown
	await expect(dropdown.getByText('Unassigned')).toBeHidden();

	// Click outside (on the main content area)
	await page.locator('h1').click();

	// Dropdown should close
	await expect(dropdown).toBeHidden();
});

test('sidebar shows agent status badges', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompanyWithAgents(page);

	await page.goto(`/companies/${company.id}`);
	await expect(page.getByRole('link', { name: 'Issues' })).toBeVisible({ timeout: 10000 });

	// Expand the Team section if collapsed
	const teamHeader = page.getByText('Team', { exact: true });
	await expect(teamHeader).toBeVisible();

	// Verify at least one agent in the sidebar has a status badge
	const sidebar = page.locator('nav');
	await expect(
		sidebar
			.getByText('Idle')
			.or(sidebar.getByText('Running'))
			.or(sidebar.getByText('Paused'))
			.first(),
	).toBeVisible({ timeout: 10000 });
});
