import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

test('sub-tasks panel is expanded by default and collapses on click', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const captain = agents.find((a) => a.slug === 'captain')!;
	const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Sub-Tasks Project'),
		description: 'Seeded for sub-tasks test.',
	});
	const project = (await projectRes.json()).data;

	const parentRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Parent Task', assignee_id: engineer.id },
	});
	const parent = (await parentRes.json()).data;

	const childARes = await page.request.post(`/api/teams/${team.id}/tasks/${parent.id}/sub-tasks`, {
		headers,
		data: { title: 'Child Task Alpha', assignee_id: engineer.id },
	});
	expect(childARes.ok()).toBeTruthy();
	const childBRes = await page.request.post(`/api/teams/${team.id}/tasks/${parent.id}/sub-tasks`, {
		headers,
		data: { title: 'Child Task Beta', assignee_id: engineer.id },
	});
	expect(childBRes.ok()).toBeTruthy();

	await page.goto(`/teams/${team.id}/tasks/${parent.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Parent Task' })).toBeVisible({ timeout: 20000 });

	const toggle = page.getByTestId('sub-tasks-toggle');
	await expect(toggle).toBeVisible();
	await expect(toggle).toContainText('Sub-tasks');
	await expect(toggle).toContainText('2');
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	const list = page.getByTestId('sub-tasks-list');
	await expect(list).toBeVisible();
	await expect(list.getByText('Child Task Alpha')).toBeVisible();
	await expect(list.getByText('Child Task Beta')).toBeVisible();

	await expect(page.getByTestId('sub-tasks-show-more')).toHaveCount(0);

	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(list).toBeHidden();

	expect(captain).toBeDefined();
});

test('sub-tasks paginate to team page size with a Show more link', async ({
	page,
	freshWorkspace,
}) => {
	const { team, token, agents } = freshWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const patchRes = await page.request.patch(`/api/teams/${team.id}`, {
		headers,
		data: { settings: { subtask_page_size: 3 } },
	});
	expect(patchRes.ok()).toBeTruthy();

	const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Pagination Project',
		description: 'Seeded for pagination test.',
	});
	const project = (await projectRes.json()).data;

	const parentRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Pagination Parent', assignee_id: engineer.id },
	});
	const parent = (await parentRes.json()).data;

	const titles = ['Sub A', 'Sub B', 'Sub C', 'Sub D', 'Sub E', 'Sub F', 'Sub G'];
	for (const title of titles) {
		const res = await page.request.post(`/api/teams/${team.id}/tasks/${parent.id}/sub-tasks`, {
			headers,
			data: { title, assignee_id: engineer.id },
		});
		expect(res.ok()).toBeTruthy();
	}

	await page.goto(`/teams/${team.id}/tasks/${parent.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Pagination Parent' })).toBeVisible({
		timeout: 20000,
	});

	const list = page.getByTestId('sub-tasks-list');
	await expect(list).toBeVisible();

	await expect(list.getByTestId('sub-task-item')).toHaveCount(3);
	const showMore = page.getByTestId('sub-tasks-show-more');
	await expect(showMore).toBeVisible();
	await expect(showMore).toContainText('4 hidden');

	await showMore.click();
	await expect(list.getByTestId('sub-task-item')).toHaveCount(6);
	await expect(showMore).toContainText('1 hidden');

	await showMore.click();
	await expect(list.getByTestId('sub-task-item')).toHaveCount(7);
	await expect(page.getByTestId('sub-tasks-show-more')).toHaveCount(0);
});

test('sub-tasks panel sits between description card and comments', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Layout Project'),
		description: 'Seeded for layout check.',
	});
	const project = (await projectRes.json()).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Layout Parent',
			description: 'Some description body.',
			assignee_id: engineer.id,
		},
	});
	const task = (await taskRes.json()).data;

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Layout Parent' })).toBeVisible({
		timeout: 20000,
	});

	const descriptionCard = page.getByTestId('task-description-card');
	await expect(descriptionCard).toBeVisible();
	await expect(descriptionCard).toContainText('Description');
	await expect(descriptionCard.getByTestId('task-description')).toBeVisible();

	const subTasksCard = page.getByTestId('sub-tasks-card');
	await expect(subTasksCard).toBeVisible();

	const descBox = await descriptionCard.boundingBox();
	const subBox = await subTasksCard.boundingBox();
	const commentsHeading = page.getByRole('heading', { name: 'Comments' });
	const commentsBox = await commentsHeading.boundingBox();

	expect(descBox).not.toBeNull();
	expect(subBox).not.toBeNull();
	expect(commentsBox).not.toBeNull();
	expect(subBox!.y).toBeGreaterThan(descBox!.y);
	expect(commentsBox!.y).toBeGreaterThan(subBox!.y);
});
