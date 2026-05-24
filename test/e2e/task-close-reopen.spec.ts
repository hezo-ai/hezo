import { expect, test } from '@playwright/test';
import {
	authenticate,
	createTeamWithAgents,
	saveAndWaitForRefetch,
	taskMatcher,
	waitForPageLoad,
} from './helpers';

test('board member can close and re-open an task via themed modal', async ({ page }) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await page.request.post(`/api/teams/${team.id}/projects`, {
		headers,
		data: { name: 'Close Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Closable Task', assignee_id: agent.id },
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.goto(
		`/teams/${team.slug}/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`,
	);
	await waitForPageLoad(page);

	const closeButton = page.getByTestId('task-close-button');
	await expect(closeButton).toBeVisible();
	await closeButton.click();

	const dialog = page.getByTestId('confirm-dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText('Close this task?')).toBeVisible();

	// Scope to this exact task: the planning-task closure that Captain wakeups
	// fire concurrently goes through the same endpoint shape and would race a
	// loose matcher. Wait for both the PATCH and the follow-up task GET that
	// useUpdateTask's invalidation triggers so the UI is guaranteed to reflect
	// the close before we assert.
	const taskPatch = taskMatcher({ teamId: team.slug, taskId: task.id, method: 'PATCH' });
	const taskGet = taskMatcher({ teamId: team.slug, taskId: task.id, method: 'GET' });

	await saveAndWaitForRefetch(page, page.getByTestId('confirm-dialog-confirm'), {
		mutation: taskPatch,
		refetch: taskGet,
	});
	await expect(dialog).toBeHidden();

	await expect(page.getByTestId('task-reopen-button')).toBeVisible({ timeout: 20000 });
	await expect(page.locator('text=closed').first()).toBeVisible();

	await page.getByTestId('task-reopen-button').click();
	await expect(page.getByTestId('confirm-dialog')).toBeVisible();
	await expect(page.getByText('Re-open this task?')).toBeVisible();

	await saveAndWaitForRefetch(page, page.getByTestId('confirm-dialog-confirm'), {
		mutation: taskPatch,
		refetch: taskGet,
	});
	await expect(page.getByTestId('confirm-dialog')).toBeHidden();

	await expect(page.getByTestId('task-close-button')).toBeVisible({ timeout: 20000 });
});

test('task detail no longer shows a delete button or status pill row', async ({ page }) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await page.request.post(`/api/teams/${team.id}/projects`, {
		headers,
		data: { name: 'No Delete Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Plain Task', assignee_id: agent.id },
	});
	const task = ((await taskRes.json()) as { data: { identifier: string } }).data;

	await page.goto(
		`/teams/${team.slug}/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`,
	);
	await waitForPageLoad(page);

	await expect(page.getByRole('button', { name: /Delete Task/i })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'in progress' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'review' })).toHaveCount(0);
	await expect(page.getByTestId('task-close-button')).toBeVisible();
});
