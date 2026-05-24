import { expect, test } from '@playwright/test';
import { authenticate, createTeamWithAgents, waitForPageLoad } from './helpers';

test('sub-tasks panel is expanded by default and collapses on click', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; slug: string }[];
	const captain = agents.find((a) => a.slug === 'captain')!;
	const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

	const projectRes = await page.request.post(`/api/teams/${team.id}/projects`, {
		headers,
		data: { name: 'Sub-Tasks Project', description: 'Seeded for sub-tasks test.' },
	});
	const project = (await projectRes.json()).data;

	const parentRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Parent Task', assignee_id: engineer.id },
	});
	const parent = (await parentRes.json()).data;

	const childAPayload = {
		title: 'Child Task Alpha',
		assignee_id: engineer.id,
	};
	const childBPayload = {
		title: 'Child Task Beta',
		assignee_id: engineer.id,
	};
	const childARes = await page.request.post(`/api/teams/${team.id}/tasks/${parent.id}/sub-tasks`, {
		headers,
		data: childAPayload,
	});
	expect(childARes.ok()).toBeTruthy();
	const childBRes = await page.request.post(`/api/teams/${team.id}/tasks/${parent.id}/sub-tasks`, {
		headers,
		data: childBPayload,
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

	// With only 2 sub-tasks and a default page size of 10, no "Show more" should appear.
	await expect(page.getByTestId('sub-tasks-show-more')).toHaveCount(0);

	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(list).toBeHidden();

	// Captain agent variable retained to validate presence in the seeded team.
	expect(captain).toBeDefined();
});

test('sub-tasks paginate to team page size with a Show more link', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	// Set the page size to 3 for this team so we don't have to seed dozens of sub-tasks.
	const patchRes = await page.request.patch(`/api/teams/${team.id}`, {
		headers,
		data: { settings: { subtask_page_size: 3 } },
	});
	expect(patchRes.ok()).toBeTruthy();

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; slug: string }[];
	const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

	const projectRes = await page.request.post(`/api/teams/${team.id}/projects`, {
		headers,
		data: { name: 'Pagination Project', description: 'Seeded for pagination test.' },
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

	// First batch — 3 visible, 4 hidden.
	await expect(list.getByTestId('sub-task-item')).toHaveCount(3);
	const showMore = page.getByTestId('sub-tasks-show-more');
	await expect(showMore).toBeVisible();
	await expect(showMore).toContainText('4 hidden');

	// Second batch — 6 visible, 1 hidden.
	await showMore.click();
	await expect(list.getByTestId('sub-task-item')).toHaveCount(6);
	await expect(showMore).toContainText('1 hidden');

	// Final batch — all 7 visible, link gone.
	await showMore.click();
	await expect(list.getByTestId('sub-task-item')).toHaveCount(7);
	await expect(page.getByTestId('sub-tasks-show-more')).toHaveCount(0);
});

test('sub-tasks panel sits between description card and comments', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; slug: string }[];
	const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

	const projectRes = await page.request.post(`/api/teams/${team.id}/projects`, {
		headers,
		data: { name: 'Layout Project', description: 'Seeded for layout check.' },
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
