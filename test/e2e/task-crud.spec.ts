import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
	createProjectAndClearPlanning,
	uniqueName,
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

test('can create an task with required assignee', async ({ sharedPage: page, sharedWorkspace }) => {
	const { team, token, agents } = sharedWorkspace;
	const agent = agents[0] as { id: string; title: string };

	const projectName = uniqueName('Test Project');
	await createProjectAndClearPlanning(page, team.id, token, {
		name: projectName,
		description: 'Test project.',
	});

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
		.selectOption({ label: projectName });

	await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();

	await page
		.locator('select')
		.filter({ hasText: 'Select assignee' })
		.selectOption({ label: agent.title });

	await expect(page.getByRole('button', { name: 'Create' })).toBeEnabled();
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByText('Test Task')).toBeVisible({ timeout: 20000 });
});

test('task detail shows execution lock banner when locked', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Lock Project'),
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;
	const agent = agents[0];

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Locked Task', assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data;

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

test('task detail lists every agent running concurrently on a ticket', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Concurrent Project'),
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	expect(agents.length).toBeGreaterThanOrEqual(2);
	const [firstAgent, secondAgent] = agents as Array<{ id: string; title: string }>;

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
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Running Link Project'),
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;
	const agent = agents[0] as { id: string; title: string };

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

test('can edit task rules and progress summary', async ({ sharedPage: page, sharedWorkspace }) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agent = agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Rules Project'),
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Rules Test Task', assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data as { id: string; identifier: string };

	await waitForAgentIdle(page, team.id, agent.id, token);

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Rules Test Task' })).toBeVisible({
		timeout: 20000,
	});

	const taskPath = `/api/teams/${team.id}/tasks/${task.identifier.toLowerCase()}`;

	const rulesSection = page.getByTestId('pinned-rules');
	await rulesSection.getByText('Edit').click();
	await rulesSection.locator('textarea').fill('Consult architect before changes');
	await rulesSection.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Consult architect before changes')).toBeVisible({ timeout: 30000 });
	const rulesPatch = await page.request.patch(taskPath, {
		headers,
		data: { rules: 'Consult architect before changes' },
	});
	expect(rulesPatch.ok()).toBe(true);

	const summarySection = page.getByTestId('pinned-progress-summary');
	await summarySection.getByText('Edit').click();
	await summarySection.locator('textarea').fill('Implementation started');
	await summarySection.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Implementation started')).toBeVisible({ timeout: 30000 });
	const summaryPatch = await page.request.patch(taskPath, {
		headers,
		data: { progress_summary: 'Implementation started' },
	});
	expect(summaryPatch.ok()).toBe(true);

	await page.reload();
	await waitForPageLoad(page);
	await expect(page.getByText('Consult architect before changes')).toBeVisible({ timeout: 15000 });
	await expect(page.getByText('Implementation started')).toBeVisible({ timeout: 15000 });

	const pinnedSummary = page.getByTestId('pinned-progress-summary');
	const pinnedRules = page.getByTestId('pinned-rules');
	await expect(pinnedSummary).toBeVisible();
	await expect(pinnedRules).toBeVisible();
});

test('task rules and progress summary render markdown formatting', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agent = agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Markdown Project'),
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Markdown Test Task', assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data as { id: string; identifier: string };

	await waitForAgentIdle(page, team.id, agent.id, token);

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Markdown Test Task' })).toBeVisible({
		timeout: 20000,
	});

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
		headers,
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
		headers,
		data: { progress_summary: summaryBody },
	});
	expect(summaryPatch.ok()).toBe(true);

	await page.reload();
	await waitForPageLoad(page);
	await expect(pinnedRules.locator('strong', { hasText: 'bold' })).toBeVisible({ timeout: 15000 });
	await expect(pinnedSummary.locator('ol li', { hasText: 'Scaffolded routes' })).toBeVisible();
});

test('task detail shows assignee with status badge', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const agent = agents[0] as { id: string; title: string };

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Assignee Project'),
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

	const sidebar = page.locator('.grid > div:last-child');
	await expect(sidebar.getByText(agent.title)).toBeVisible({ timeout: 20000 });

	await expect(
		sidebar.getByText('Idle').or(sidebar.getByText('Running')).or(sidebar.getByText('Paused')),
	).toBeVisible();

	await expect(sidebar.locator('button svg.lucide-chevron-down')).toBeVisible();
});

test('can change assignee via popover dropdown', async ({ sharedPage: page, sharedWorkspace }) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	expect(agents.length).toBeGreaterThanOrEqual(2);
	const agent1 = agents[0] as { id: string; title: string };
	const agent2 = agents[1] as { id: string; title: string };

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Change Assignee Project'),
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

	await sidebar.locator('button', { has: page.locator('svg.lucide-chevron-down') }).click();

	const dropdown = sidebar.locator('.absolute');
	await expect(dropdown).toBeVisible();
	await expect(dropdown.getByText(agent2.title)).toBeVisible();

	await dropdown.locator('button', { hasText: agent2.title }).click();

	await expect(dropdown).toBeHidden();
	await expect(sidebar.getByText(agent2.title)).toBeVisible({ timeout: 20000 });
});

test('assignee dropdown closes on outside click and has no unassign option', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const agent = agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Outside Click Project'),
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

	await sidebar.locator('button', { has: page.locator('svg.lucide-chevron-down') }).click();
	const dropdown = sidebar.locator('.absolute');
	await expect(dropdown).toBeVisible();

	await expect(dropdown.getByText('Unassigned')).toBeHidden();

	await page.getByRole('heading', { name: 'Outside Click Task' }).click();

	await expect(dropdown).toBeHidden();
});

test('Internal project restricts assignee dropdown to the Captain', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, agents } = sharedWorkspace;
	const captain = agents.find((a) => (a as any).slug === 'captain') as
		| { title: string; slug: string }
		| undefined;
	expect(captain).toBeDefined();
	const engineer = agents.find((a) => (a as any).slug === 'engineer') as
		| { title: string; slug: string }
		| undefined;
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

test('task description renders markdown', async ({ sharedPage: page, sharedWorkspace }) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const agent = agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Markdown Desc Project'),
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

test('project badge and metadata label both link to the project page', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const agent = agents[0];

	const linkableName = uniqueName('Linkable Project');
	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: linkableName,
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
	const badgeLink = mainContent.getByRole('link', { name: linkableName });
	await expect(badgeLink).toHaveAttribute('href', expectedHref);

	const metadataPanel = page.locator('.grid > div').last();
	const metadataLink = metadataPanel.getByRole('link', { name: linkableName });
	await expect(metadataLink).toHaveAttribute('href', expectedHref);

	await metadataLink.click();
	await expect(page).toHaveURL(`${expectedHref}/tasks`);
	await expect(page.getByTestId('breadcrumb').getByText(linkableName)).toBeVisible({
		timeout: 20000,
	});
});

test('sidebar shows agent status badges', async ({ sharedPage: page, sharedWorkspace }) => {
	const { team } = sharedWorkspace;

	await page.goto(`/teams/${team.slug}/agents/captain`);
	await waitForPageLoad(page);

	await expect(page.getByRole('main').getByText('Idle')).toBeVisible({ timeout: 20000 });
});
