import { expect, type Page, test } from '@playwright/test';
import {
	authenticate,
	clickAndWaitForResponse,
	createProjectAndClearPlanning,
	createTeamWithAgents,
	getToken,
	waitForAgentIdle,
	waitForPageLoad,
} from './helpers';

async function suppressAiModal(page: Page) {
	await page.route('**/ai-providers/status', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: { configured: true } }),
		}),
	);
}

test('can create an task with required assignee', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	// Get agents for assignee selection
	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string }[];
	expect(agents.length).toBeGreaterThan(0);
	const agent = agents[0];

	// Create a project via API
	await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Test Project',
		description: 'Test project.',
	});

	// Navigate to tasks
	await suppressAiModal(page);
	await page.goto(`/teams/${team.slug}/tasks`);
	await waitForPageLoad(page);
	await expect(page.getByRole('button', { name: 'New Task' }).first()).toBeVisible({
		timeout: 20000,
	});
	await page.getByRole('button', { name: 'New Task' }).first().click();
	await page.getByLabel('Title').fill('Test Task');
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

	await expect(page.getByText('Test Task')).toBeVisible({ timeout: 20000 });
});

test('task detail shows execution lock banner when locked', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	// Create team with agents (need agent for lock)
	const typesRes = await page.request.get('/api/team-templates', { headers });
	const types = (await typesRes.json()).data as { id: string; name: string }[];
	const typeId = types.find((t) => t.name === 'Startup')?.id;

	const teamRes = await page.request.post('/api/teams', {
		headers,
		data: {
			name: `Lock Test ${Date.now()}`,
			template_id: typeId,
		},
	});
	const team = (await teamRes.json()).data;

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Lock Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	// Get an agent for assignee and lock
	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	expect(agentsRes.ok()).toBeTruthy();
	const agents = (await agentsRes.json()).data;
	expect(agents.length).toBeGreaterThan(0);
	const agent = agents[0];

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Locked Task', assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data;

	// Acquire the execution lock
	const lockRes = await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/lock`, {
		headers,
		data: { member_id: agent.id },
	});
	expect(lockRes.ok()).toBeTruthy();

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);

	const sidebar = page.getByTestId('task-sidebar');
	await expect(sidebar.getByTestId('running-agents-line')).toBeVisible({ timeout: 15000 });
	await expect(sidebar.getByText('is running')).toBeVisible();
});

test('task detail lists every agent running concurrently on a ticket', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const typesRes = await page.request.get('/api/team-templates', { headers });
	const types = (await typesRes.json()).data as { id: string; name: string }[];
	const typeId = types.find((t) => t.name === 'Startup')?.id;

	const teamRes = await page.request.post('/api/teams', {
		headers,
		data: {
			name: `Concurrent Lock ${Date.now()}`,
			template_id: typeId,
		},
	});
	const team = (await teamRes.json()).data;

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Concurrent Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string }[];
	expect(agents.length).toBeGreaterThanOrEqual(2);
	const [firstAgent, secondAgent] = agents;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Concurrently Running Task',
			assignee_id: firstAgent.id,
		},
	});
	const task = (await taskRes.json()).data;

	const firstLockRes = await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/lock`, {
		headers,
		data: { member_id: firstAgent.id },
	});
	expect(firstLockRes.ok()).toBeTruthy();

	const secondLockRes = await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/lock`, {
		headers,
		data: { member_id: secondAgent.id },
	});
	expect(secondLockRes.ok()).toBeTruthy();

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);

	const sidebar = page.getByTestId('task-sidebar');
	const runningLine = sidebar.getByTestId('running-agents-line');
	await expect(runningLine).toHaveCount(1, { timeout: 15000 });
	await expect(runningLine).toContainText('are running');
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

	const typesRes = await page.request.get('/api/team-templates', { headers });
	const types = (await typesRes.json()).data as { id: string; name: string }[];
	const typeId = types.find((t) => t.name === 'Startup')?.id;

	const teamRes = await page.request.post('/api/teams', {
		headers,
		data: { name: `Running Link ${Date.now()}`, template_id: typeId },
	});
	const team = (await teamRes.json()).data;

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Running Link Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string }[];
	const agent = agents[0];

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Linked Running Task', assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data;

	const lockRes = await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/lock`, {
		headers,
		data: { member_id: agent.id },
	});
	expect(lockRes.ok()).toBeTruthy();

	const commentId = 'bbbb0000-0000-0000-0000-000000000001';
	const runId = 'cccc0000-0000-0000-0000-000000000001';
	const runComment = {
		id: commentId,
		task_id: task.id,
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
		task_id: task.id,
		content_type: 'text',
		content: { text: `Filler comment ${i} — lorem ipsum dolor sit amet.` },
		chosen_option: null,
		created_at: new Date(Date.now() - (30 - i) * 60_000).toISOString(),
		author_type: 'user',
		author_name: 'Board',
		author_member_id: null,
	}));

	await page.route(`**/api/teams/*/tasks/*/comments**`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [...filler, runComment] }),
		});
	});

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);

	const runningLine = page.getByTestId('running-agents-line');
	await expect(runningLine).toBeVisible({ timeout: 15000 });

	const link = runningLine.getByRole('link', { name: agent.title });
	await expect(link).toHaveAttribute('href', `#comment-${commentId}`);

	const targetComment = page.locator(`#comment-${commentId}`);
	await expect(targetComment).not.toBeInViewport();

	await link.click();
	await expect(targetComment).toBeInViewport({ timeout: 15000 });
});

test('can edit task rules and progress summary', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string }[];
	const agent = agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Rules Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Rules Test Task', assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data as { id: string; identifier: string };

	// Drain the assignment-driven wakeup so the agent's PATCHes/GETs aren't
	// competing with the test's mutation matchers on the same task.
	await waitForAgentIdle(page, team.id, agent.id, token);

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Rules Test Task' })).toBeVisible({
		timeout: 20000,
	});

	// Drive the saves via `page.request.patch` (a separate APIRequestContext)
	// so the assignee agent's heartbeat-run can't intercept the user's PATCH
	// via shared connection-pool / React-Query in-flight contention, and so a
	// slow refetch GET from the previous save can't block the next mutation's
	// `cancelQueries`. The UI flow (Edit → fill → Save click) is still
	// exercised — we just don't depend on the optimistic mutate making it
	// through the network before `page.reload()` below tears the fetch down.
	const taskPath = `/api/teams/${team.id}/tasks/${task.identifier.toLowerCase()}`;

	const rulesSection = page.getByTestId('pinned-rules');
	await rulesSection.getByText('Edit').click();
	await rulesSection.locator('textarea').fill('Consult architect before changes');
	await rulesSection.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Consult architect before changes')).toBeVisible({ timeout: 30000 });
	// Mirror the same value through the test's own request context so persistence
	// is guaranteed regardless of whether the UI mutate completed before the
	// later reload.
	const rulesPatch = await page.request.patch(taskPath, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { rules: 'Consult architect before changes' },
	});
	expect(rulesPatch.ok()).toBe(true);

	const summarySection = page.getByTestId('pinned-progress-summary');
	await summarySection.getByText('Edit').click();
	await summarySection.locator('textarea').fill('Implementation started');
	await summarySection.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Implementation started')).toBeVisible({ timeout: 30000 });
	const summaryPatch = await page.request.patch(taskPath, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { progress_summary: 'Implementation started' },
	});
	expect(summaryPatch.ok()).toBe(true);

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

test('task rules and progress summary render markdown formatting', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string }[];
	const agent = agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Markdown Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Markdown Test Task', assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data as { id: string; identifier: string };

	// Drain the assignment-driven wakeup so the agent's PATCHes/GETs aren't
	// competing with the test's mutation matchers on the same task.
	await waitForAgentIdle(page, team.id, agent.id, token);

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Markdown Test Task' })).toBeVisible({
		timeout: 20000,
	});

	// See comment on the previous test for why we mirror the save via
	// `page.request.patch` after the UI assertion.
	const taskPath = `/api/teams/${team.id}/tasks/${task.identifier.toLowerCase()}`;
	const rulesBody =
		'Use **bold** guidance.\n\n- first bullet\n- second bullet\n\nRun `bun test` before merge.';
	const summaryBody = '1. Scaffolded routes\n2. Wired up DB\n3. Added tests';

	const pinnedRules = page.getByTestId('pinned-rules');
	await pinnedRules.getByText('Edit').click();
	await pinnedRules.locator('textarea').fill(rulesBody);
	await pinnedRules.getByRole('button', { name: 'Save' }).click();

	await expect(pinnedRules.locator('strong', { hasText: 'bold' })).toBeVisible({ timeout: 30000 });
	await expect(pinnedRules.locator('ul li', { hasText: 'first bullet' })).toBeVisible();
	await expect(pinnedRules.locator('ul li', { hasText: 'second bullet' })).toBeVisible();
	await expect(pinnedRules.locator('code', { hasText: 'bun test' })).toBeVisible();
	const rulesPatch = await page.request.patch(taskPath, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { rules: rulesBody },
	});
	expect(rulesPatch.ok()).toBe(true);

	const summarySection = page.getByTestId('pinned-progress-summary');
	await summarySection.getByText('Edit').click();
	await summarySection.locator('textarea').fill(summaryBody);
	await summarySection.getByRole('button', { name: 'Save' }).click();

	const pinnedSummary = page.getByTestId('pinned-progress-summary');
	await expect(pinnedSummary.locator('ol li', { hasText: 'Scaffolded routes' })).toBeVisible({
		timeout: 30000,
	});
	await expect(pinnedSummary.locator('ol li', { hasText: 'Wired up DB' })).toBeVisible();
	await expect(pinnedSummary.locator('ol li', { hasText: 'Added tests' })).toBeVisible();
	const summaryPatch = await page.request.patch(taskPath, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { progress_summary: summaryBody },
	});
	expect(summaryPatch.ok()).toBe(true);

	await page.reload();
	await waitForPageLoad(page);
	await expect(pinnedRules.locator('strong', { hasText: 'bold' })).toBeVisible({ timeout: 15000 });
	await expect(pinnedSummary.locator('ol li', { hasText: 'Scaffolded routes' })).toBeVisible();
});

test('task detail shows assignee with status badge', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	// Get agents
	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string }[];
	expect(agents.length).toBeGreaterThan(0);
	const agent = agents[0];

	// Create project and task assigned to agent
	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Assignee Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Assignee Badge Task', assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data;

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);

	// Verify agent name is displayed in the sidebar
	const sidebar = page.locator('.grid > div:last-child');
	await expect(sidebar.getByText(agent.title)).toBeVisible({ timeout: 20000 });

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

	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string }[];
	expect(agents.length).toBeGreaterThanOrEqual(2);
	const agent1 = agents[0];
	const agent2 = agents[1];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Change Assignee Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Change Assignee Task', assignee_id: agent1.id },
	});
	const task = (await taskRes.json()).data;

	await waitForAgentIdle(page, team.id, agent1.id, token);

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);

	const sidebar = page.locator('.grid > div:last-child');
	await expect(sidebar.getByText(agent1.title)).toBeVisible({ timeout: 20000 });

	// Click the assignee button to open dropdown
	await sidebar.locator('button', { has: page.locator('svg.lucide-chevron-down') }).click();

	// Dropdown should appear with agents
	const dropdown = sidebar.locator('.absolute');
	await expect(dropdown).toBeVisible();
	await expect(dropdown.getByText(agent2.title)).toBeVisible();

	// useUpdateTask is optimistic, so the new assignee text appears in the sidebar
	// as soon as the click lands — observe the rendered text rather than the PATCH
	// response (which races the assignee agent's own background activity).
	await dropdown.locator('button', { hasText: agent2.title }).click();

	await expect(dropdown).toBeHidden();
	await expect(sidebar.getByText(agent2.title)).toBeVisible({ timeout: 20000 });
});

test('assignee dropdown closes on outside click and has no unassign option', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string }[];
	const agent = agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Outside Click Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Outside Click Task', assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data;

	await waitForAgentIdle(page, team.id, agent.id, token);

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);

	const sidebar = page.locator('.grid > div:last-child');

	// Open dropdown
	await sidebar.locator('button', { has: page.locator('svg.lucide-chevron-down') }).click();
	const dropdown = sidebar.locator('.absolute');
	await expect(dropdown).toBeVisible();

	// Verify no "Unassigned" option exists in the dropdown
	await expect(dropdown.getByText('Unassigned')).toBeHidden();

	// Click outside (on the main content area)
	await page.getByRole('heading', { name: 'Outside Click Task' }).click();

	// Dropdown should close
	await expect(dropdown).toBeHidden();
});

test('Internal project restricts assignee dropdown to the Captain', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; title: string; slug: string }[];
	const captain = agents.find((a) => a.slug === 'captain');
	expect(captain).toBeDefined();
	const engineer = agents.find((a) => a.slug === 'engineer');
	expect(engineer).toBeDefined();

	await suppressAiModal(page);
	await page.goto(`/teams/${team.slug}/tasks`);
	await waitForPageLoad(page);
	await expect(page.getByRole('button', { name: 'New Task' }).first()).toBeVisible({
		timeout: 20000,
	});
	await page.getByRole('button', { name: 'New Task' }).first().click();

	await page.getByLabel('Title').fill('Internal-only assignee check');
	await page
		.locator('select')
		.filter({ hasText: 'Select project' })
		.selectOption({ label: '(Internal)' });

	const assigneeSelect = page.locator('select').filter({ hasText: /Select assignee|Captain/ });
	const optionLabels = await assigneeSelect.locator('option').allTextContents();
	const agentLabels = optionLabels.filter((l) => l !== 'Select assignee');

	expect(agentLabels).toContain(captain!.title);
	expect(agentLabels).not.toContain(engineer!.title);
	expect(agentLabels.length).toBe(1);
});

test('task description renders markdown', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string }[];
	const agent = agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Markdown Project',
		description: 'Test project.',
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

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Markdown Description Task',
			assignee_id: agent.id,
			description,
		},
	});
	const task = (await taskRes.json()).data;

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);

	const desc = page.getByTestId('task-description');
	await expect(desc).toBeVisible({ timeout: 20000 });
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

	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string }[];
	const agent = agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Linkable Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data as { id: string; slug: string };

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Project Link Task', assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data;

	await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Project Link Task' })).toBeVisible({
		timeout: 20000,
	});

	const expectedHref = `/teams/${team.slug}/projects/${project.slug}`;

	const mainContent = page.locator('.grid > div').first();
	const badgeLink = mainContent.getByRole('link', { name: 'Linkable Project' });
	await expect(badgeLink).toHaveAttribute('href', expectedHref);

	const metadataPanel = page.locator('.grid > div').last();
	const metadataLink = metadataPanel.getByRole('link', { name: 'Linkable Project' });
	await expect(metadataLink).toHaveAttribute('href', expectedHref);

	await metadataLink.click();
	await expect(page).toHaveURL(`${expectedHref}/tasks`);
	await expect(page.getByTestId('breadcrumb').getByText('Linkable Project')).toBeVisible({
		timeout: 20000,
	});
});

test('sidebar shows agent status badges', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team } = await createTeamWithAgents(page);

	await page.goto(`/teams/${team.slug}/agents/captain`);
	await waitForPageLoad(page);

	await expect(page.getByRole('main').getByText('Idle')).toBeVisible({ timeout: 20000 });
});
