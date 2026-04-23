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
		data: { name: 'Test Project', description: 'Test project.' },
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
			template_id: typeId,
		},
	});
	const company = (await companyRes.json()).data;

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Lock Project', description: 'Test project.' },
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

	await expect(page.getByText('is running on this issue')).toBeVisible({ timeout: 15000 });
});

test('issue detail lists every agent running concurrently on a ticket', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const typesRes = await page.request.get('/api/company-types', { headers });
	const types = (await typesRes.json()).data as { id: string; name: string }[];
	const typeId = types.find((t) => t.name === 'Startup')?.id;

	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: {
			name: `Concurrent Lock ${Date.now()}`,
			template_id: typeId,
		},
	});
	const company = (await companyRes.json()).data;

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Concurrent Project', description: 'Test project.' },
	});
	const project = (await projectRes.json()).data;

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string }[];
	expect(agents.length).toBeGreaterThanOrEqual(2);
	const [firstAgent, secondAgent] = agents;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Concurrently Running Issue',
			assignee_id: firstAgent.id,
		},
	});
	const issue = (await issueRes.json()).data;

	const firstLockRes = await page.request.post(
		`/api/companies/${company.id}/issues/${issue.id}/lock`,
		{ headers, data: { member_id: firstAgent.id } },
	);
	expect(firstLockRes.ok()).toBeTruthy();

	const secondLockRes = await page.request.post(
		`/api/companies/${company.id}/issues/${issue.id}/lock`,
		{ headers, data: { member_id: secondAgent.id } },
	);
	expect(secondLockRes.ok()).toBeTruthy();

	await page.goto(`/companies/${company.id}/issues/${issue.id}`);
	await waitForPageLoad(page);

	const runningLine = page.getByTestId('running-agents-line');
	await expect(runningLine).toHaveCount(1, { timeout: 15000 });
	await expect(runningLine).toContainText('are running on this issue');
	await expect(runningLine).toContainText(firstAgent.title);
	await expect(runningLine).toContainText(secondAgent.title);
	await expect(runningLine).toContainText(' and ');
});

test('running-agents line links each name to its run comment and scrolls into view', async ({
	page,
}) => {
	await page.goto('/');
	await authenticate(page);

	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const typesRes = await page.request.get('/api/company-types', { headers });
	const types = (await typesRes.json()).data as { id: string; name: string }[];
	const typeId = types.find((t) => t.name === 'Startup')?.id;

	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: { name: `Running Link ${Date.now()}`, template_id: typeId },
	});
	const company = (await companyRes.json()).data;

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Running Link Project', description: 'Test project.' },
	});
	const project = (await projectRes.json()).data;

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string }[];
	const agent = agents[0];

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Linked Running Issue', assignee_id: agent.id },
	});
	const issue = (await issueRes.json()).data;

	const lockRes = await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/lock`, {
		headers,
		data: { member_id: agent.id },
	});
	expect(lockRes.ok()).toBeTruthy();

	const commentId = 'bbbb0000-0000-0000-0000-000000000001';
	const runId = 'cccc0000-0000-0000-0000-000000000001';
	const runComment = {
		id: commentId,
		issue_id: issue.id,
		content_type: 'run',
		content: { run_id: runId, agent_id: agent.id, agent_title: agent.title },
		chosen_option: null,
		created_at: new Date().toISOString(),
		author_type: 'agent',
		author_name: agent.title,
		author_member_id: agent.id,
	};

	// Pad with filler text comments so the run comment sits below the fold.
	const filler = Array.from({ length: 20 }, (_, i) => ({
		id: `dddd0000-0000-0000-0000-${String(i).padStart(12, '0')}`,
		issue_id: issue.id,
		content_type: 'text',
		content: { text: `Filler comment ${i} — lorem ipsum dolor sit amet.` },
		chosen_option: null,
		created_at: new Date(Date.now() - (30 - i) * 60_000).toISOString(),
		author_type: 'user',
		author_name: 'Board',
		author_member_id: null,
	}));

	await page.route(`**/api/companies/*/issues/*/comments**`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [...filler, runComment] }),
		});
	});

	await page.goto(`/companies/${company.id}/issues/${issue.id}`);
	await waitForPageLoad(page);

	const runningLine = page.getByTestId('running-agents-line');
	await expect(runningLine).toBeVisible({ timeout: 15000 });

	const link = runningLine.getByRole('link', { name: agent.title });
	await expect(link).toHaveAttribute('href', `#comment-${commentId}`);

	const targetComment = page.locator(`#comment-${commentId}`);
	await expect(targetComment).not.toBeInViewport();

	await link.click();
	await expect(targetComment).toBeInViewport({ timeout: 5000 });
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
		data: { name: 'Rules Project', description: 'Test project.' },
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

	const pinnedSummary = page.getByTestId('pinned-progress-summary');
	const pinnedRules = page.getByTestId('pinned-rules');
	await expect(pinnedSummary).toBeVisible();
	await expect(pinnedRules).toBeVisible();
});

test('issue rules and progress summary render markdown formatting', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string }[];
	const agent = agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Markdown Project', description: 'Test project.' },
	});
	const project = (await projectRes.json()).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Markdown Test Issue', assignee_id: agent.id },
	});
	const issue = (await issueRes.json()).data;

	await page.goto(`/companies/${company.id}/issues/${issue.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Markdown Test Issue' })).toBeVisible({
		timeout: 10000,
	});

	const rulesSection = page.getByText('Rules', { exact: true }).locator('..').locator('..');
	await rulesSection.getByText('Edit').click();
	await rulesSection
		.locator('textarea')
		.fill(
			'Use **bold** guidance.\n\n- first bullet\n- second bullet\n\nRun `bun test` before merge.',
		);
	await rulesSection.getByRole('button', { name: 'Save' }).click();

	const pinnedRules = page.getByTestId('pinned-rules');
	await expect(pinnedRules.locator('strong', { hasText: 'bold' })).toBeVisible({ timeout: 5000 });
	await expect(pinnedRules.locator('ul li', { hasText: 'first bullet' })).toBeVisible();
	await expect(pinnedRules.locator('ul li', { hasText: 'second bullet' })).toBeVisible();
	await expect(pinnedRules.locator('code', { hasText: 'bun test' })).toBeVisible();

	const summarySection = page
		.getByText('Progress Summary', { exact: true })
		.locator('..')
		.locator('..');
	await summarySection.getByText('Edit').click();
	await summarySection
		.locator('textarea')
		.fill('1. Scaffolded routes\n2. Wired up DB\n3. Added tests');
	await summarySection.getByRole('button', { name: 'Save' }).click();

	const pinnedSummary = page.getByTestId('pinned-progress-summary');
	await expect(pinnedSummary.locator('ol li', { hasText: 'Scaffolded routes' })).toBeVisible({
		timeout: 5000,
	});
	await expect(pinnedSummary.locator('ol li', { hasText: 'Wired up DB' })).toBeVisible();
	await expect(pinnedSummary.locator('ol li', { hasText: 'Added tests' })).toBeVisible();

	await page.reload();
	await waitForPageLoad(page);
	await expect(pinnedRules.locator('strong', { hasText: 'bold' })).toBeVisible({ timeout: 15000 });
	await expect(pinnedSummary.locator('ol li', { hasText: 'Scaffolded routes' })).toBeVisible();
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
		data: { name: 'Assignee Project', description: 'Test project.' },
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
		data: { name: 'Change Assignee Project', description: 'Test project.' },
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
		data: { name: 'Outside Click Project', description: 'Test project.' },
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
	await page.getByRole('heading', { name: 'Outside Click Issue' }).click();

	// Dropdown should close
	await expect(dropdown).toBeHidden();
});

test('operations project restricts assignee dropdown to the CEO', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string; slug: string }[];
	const ceo = agents.find((a) => a.slug === 'ceo');
	expect(ceo).toBeDefined();
	const engineer = agents.find((a) => a.slug === 'engineer');
	expect(engineer).toBeDefined();

	await suppressAiModal(page);
	await page.goto(`/companies/${company.slug}/issues`);
	await waitForPageLoad(page);
	await expect(page.getByRole('button', { name: 'New Issue' }).first()).toBeVisible({
		timeout: 10000,
	});
	await page.getByRole('button', { name: 'New Issue' }).first().click();

	await page.getByLabel('Title').fill('Operations-only assignee check');
	await page
		.locator('select')
		.filter({ hasText: 'Select project' })
		.selectOption({ label: 'Operations' });

	const assigneeSelect = page.locator('select').filter({ hasText: /Select assignee|CEO/ });
	const optionLabels = await assigneeSelect.locator('option').allTextContents();
	const agentLabels = optionLabels.filter((l) => l !== 'Select assignee');

	expect(agentLabels).toContain(ceo!.title);
	expect(agentLabels).not.toContain(engineer!.title);
	expect(agentLabels.length).toBe(1);
});

test('issue description renders markdown', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string }[];
	const agent = agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Markdown Project', description: 'Test project.' },
	});
	const project = (await projectRes.json()).data;

	const description = [
		'# Heading One',
		'',
		'- bullet item',
		'',
		'[a link](https://example.com)',
		'',
		'```',
		'const x = 1;',
		'```',
	].join('\n');

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Markdown Description Issue',
			assignee_id: agent.id,
			description,
		},
	});
	const issue = (await issueRes.json()).data;

	await page.goto(`/companies/${company.id}/issues/${issue.id}`);
	await waitForPageLoad(page);

	const desc = page.getByTestId('issue-description');
	await expect(desc).toBeVisible({ timeout: 10000 });
	await expect(desc.getByRole('heading', { level: 1, name: 'Heading One' })).toBeVisible();
	await expect(desc.getByRole('listitem').filter({ hasText: 'bullet item' })).toBeVisible();
	const link = desc.getByRole('link', { name: 'a link' });
	await expect(link).toHaveAttribute('href', 'https://example.com');
	await expect(desc.locator('pre code')).toContainText('const x = 1;');

	await expect(desc.locator('p', { hasText: '# Heading One' })).toHaveCount(0);
});

test('project badge and metadata label both link to the project page', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string }[];
	const agent = agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Linkable Project', description: 'Test project.' },
	});
	const project = (await projectRes.json()).data as { id: string; slug: string };

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Project Link Issue', assignee_id: agent.id },
	});
	const issue = (await issueRes.json()).data;

	await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Project Link Issue' })).toBeVisible({
		timeout: 10000,
	});

	const expectedHref = `/companies/${company.slug}/projects/${project.slug}`;

	const mainContent = page.locator('.grid > div').first();
	const badgeLink = mainContent.getByRole('link', { name: 'Linkable Project' });
	await expect(badgeLink).toHaveAttribute('href', expectedHref);

	const metadataPanel = page.locator('.grid > div').last();
	const metadataLink = metadataPanel.getByRole('link', { name: 'Linkable Project' });
	await expect(metadataLink).toHaveAttribute('href', expectedHref);

	await metadataLink.click();
	await expect(page).toHaveURL(expectedHref + '/issues');
	await expect(page.getByRole('heading', { name: 'Linkable Project' })).toBeVisible({
		timeout: 10000,
	});
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
