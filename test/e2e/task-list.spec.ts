import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function createProject(
	page: Page,
	teamId: string,
	token: string,
	name: string,
): Promise<{ id: string; slug: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.post(`/api/teams/${teamId}/projects`, {
		headers,
		data: { name, description: 'Test project.' },
	});
	return ((await res.json()) as { data: { id: string; slug: string } }).data;
}

async function createTask(
	page: Page,
	teamId: string,
	token: string,
	data: { project_id: string; title: string; assignee_id: string },
): Promise<{ id: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.post(`/api/teams/${teamId}/tasks`, { headers, data });
	return ((await res.json()) as { data: { id: string } }).data;
}

async function patchTaskStatus(
	page: Page,
	teamId: string,
	token: string,
	taskId: string,
	status: string,
) {
	await page.request.patch(`/api/teams/${teamId}/tasks/${taskId}`, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { status },
	});
}

test.describe('Task list — filtering', () => {
	test('default view shows non-terminal tasks with status badges and a collapsed filter bar with New Task button', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		const project = await createProject(page, team.id, token, 'Filter Project A');
		const agentId = agents[0].id;

		const tasks = await Promise.all([
			createTask(page, team.id, token, {
				project_id: project.id,
				title: 'Review Task',
				assignee_id: agentId,
			}),
			createTask(page, team.id, token, {
				project_id: project.id,
				title: 'In Progress Task',
				assignee_id: agentId,
			}),
			createTask(page, team.id, token, {
				project_id: project.id,
				title: 'Done Task',
				assignee_id: agentId,
			}),
			createTask(page, team.id, token, {
				project_id: project.id,
				title: 'Backlog Task',
				assignee_id: agentId,
			}),
		]);
		await patchTaskStatus(page, team.id, token, tasks[0].id, 'review');
		await patchTaskStatus(page, team.id, token, tasks[1].id, 'in_progress');
		await patchTaskStatus(page, team.id, token, tasks[2].id, 'done');

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		await expect(page.getByText('Review Task')).toBeVisible({ timeout: 20000 });
		await expect(page.getByText('In Progress Task')).toBeVisible();
		await expect(page.getByText('Backlog Task')).toBeVisible();
		await expect(page.getByText('Done Task')).toBeHidden();

		await expect(page.getByTestId('task-filter-bar')).toBeVisible();
		await expect(page.getByTestId('task-filter-panel')).toBeHidden();
		await expect(page.getByTestId('task-list-new-task')).toBeVisible();

		await expect(page.getByText('review').first()).toBeVisible();
		await expect(page.getByText('in progress').first()).toBeVisible();
		await expect(page.getByText('backlog').first()).toBeVisible();
	});

	test('multi-select status filter narrows results and reset restores defaults', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		const project = await createProject(page, team.id, token, 'Filter Project B');
		const agentId = agents[0].id;

		const created = await Promise.all([
			createTask(page, team.id, token, {
				project_id: project.id,
				title: 'Review Task',
				assignee_id: agentId,
			}),
			createTask(page, team.id, token, {
				project_id: project.id,
				title: 'In Progress Task',
				assignee_id: agentId,
			}),
			createTask(page, team.id, token, {
				project_id: project.id,
				title: 'Done Task',
				assignee_id: agentId,
			}),
			createTask(page, team.id, token, {
				project_id: project.id,
				title: 'Backlog Task',
				assignee_id: agentId,
			}),
		]);
		await patchTaskStatus(page, team.id, token, created[0].id, 'review');
		await patchTaskStatus(page, team.id, token, created[1].id, 'in_progress');
		await patchTaskStatus(page, team.id, token, created[2].id, 'done');

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);
		await expect(page.getByText('Review Task')).toBeVisible({ timeout: 20000 });

		await page.getByTestId('task-filter-toggle').click();
		await expect(page.getByTestId('task-filter-panel')).toBeVisible();

		await page.getByTestId('task-filter-status').click();
		await page.getByRole('button', { name: 'Clear selection' }).click();
		await page.getByRole('button', { name: 'done' }).click();
		await page.keyboard.press('Escape');

		await expect(page.getByText('Done Task')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('Review Task')).toBeHidden();
		await expect(page.getByText('Backlog Task')).toBeHidden();

		await page.getByTestId('task-filter-status').click();
		await page.getByRole('button', { name: 'Clear selection' }).click();
		await page.getByRole('button', { name: 'in progress' }).click();
		await page.keyboard.press('Escape');

		await expect(page.getByText('In Progress Task')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('Done Task')).toBeHidden();

		await page.getByTestId('task-filter-reset').click();
		await expect(page.getByText('Review Task')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('In Progress Task')).toBeVisible();
		await expect(page.getByText('Backlog Task')).toBeVisible();
		await expect(page.getByText('Done Task')).toBeHidden();
	});

	test('filter bar collapses/expands and applies search + sort', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		const project = await createProject(page, team.id, token, 'Filter Project C');
		const agentId = agents[0].id;

		for (const title of ['Authentication bug', 'Payment flow', 'Sign-up form']) {
			await createTask(page, team.id, token, {
				project_id: project.id,
				title,
				assignee_id: agentId,
			});
		}

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		const panel = page.getByTestId('task-filter-panel');
		await expect(panel).toBeHidden();
		await page.getByTestId('task-filter-toggle').click();
		await expect(panel).toBeVisible();

		const searchInput = page.getByTestId('task-filter-search');
		await searchInput.fill('Payment');

		await expect(page.getByText('Payment flow')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('Authentication bug')).toBeHidden();
		await expect(page.getByText('Sign-up form')).toBeHidden();

		await page.getByTestId('task-filter-reset').click();
		await expect(searchInput).toHaveValue('');
		await expect(page.getByText('Authentication bug')).toBeVisible();
		await expect(page.getByText('Payment flow')).toBeVisible();
		await expect(page.getByText('Sign-up form')).toBeVisible();

		await page.getByTestId('task-filter-sort-dir').selectOption('asc');
		await expect(page.getByRole('row').filter({ hasText: 'Authentication bug' })).toBeVisible();
	});
});

test.describe('Task list — running indicator', () => {
	test('running dot is hidden by default and shown when has_active_run is true', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		const project = await createProject(page, team.id, token, 'Indicator Project');
		const agentId = agents[0].id;

		await createTask(page, team.id, token, {
			project_id: project.id,
			title: 'Quiet Task',
			assignee_id: agentId,
		});
		const busy = await createTask(page, team.id, token, {
			project_id: project.id,
			title: 'Busy Task',
			assignee_id: agentId,
		});

		await page.route(`**/api/teams/${team.slug}/tasks?**`, async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			const data = Array.isArray(body) ? body : body.data;
			for (const row of data) {
				if (row.id === busy.id) row.has_active_run = true;
			}
			await route.fulfill({
				status: response.status(),
				contentType: 'application/json',
				body: JSON.stringify(body),
			});
		});

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		await expect(page.getByText('Quiet Task')).toBeVisible({ timeout: 20000 });
		await expect(page.getByText('Busy Task')).toBeVisible();

		const dots = page.getByTestId('task-running-dot');
		await expect(dots).toHaveCount(1);
		const bgColor = await dots.first().evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(bgColor).toBeTruthy();
		expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
		expect(bgColor).not.toBe('transparent');
	});

	test('tasks with active runs pin to the top regardless of sort order', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		const project = await createProject(page, team.id, token, 'Pin Project');
		const agentId = agents[0].id;

		const oldTask = await createTask(page, team.id, token, {
			project_id: project.id,
			title: 'Old running ticket',
			assignee_id: agentId,
		});
		await createTask(page, team.id, token, {
			project_id: project.id,
			title: 'New idle ticket',
			assignee_id: agentId,
		});

		await page.route(`**/api/teams/${team.slug}/tasks?**`, async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			const data = Array.isArray(body) ? body : body.data;
			const targetIdx = data.findIndex((row: { id: string }) => row.id === oldTask.id);
			if (targetIdx >= 0) {
				const target = data[targetIdx];
				target.has_active_run = true;
				data.splice(targetIdx, 1);
				data.unshift(target);
			}
			await route.fulfill({
				status: response.status(),
				contentType: 'application/json',
				body: JSON.stringify(body),
			});
		});

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		const rows = page.getByRole('row').filter({ hasText: /ticket/ });
		await expect(rows.first()).toContainText('Old running ticket', { timeout: 20000 });
	});
});
