import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function patchStatus(
	ws: SeededWorkspace,
	projectSlug: string,
	taskId: string,
	status: string,
) {
	const { apiBase } = getTestContext();
	await apiBase(`/api/projects/${projectSlug}/tasks/${taskId}`, {
		method: 'PATCH',
		headers: ws.headers,
		body: JSON.stringify({ status }),
	});
}

test('the admin can close and re-open a task via themed modal', async () => {
	const seeded = { projectSlug: '', taskId: '', identifier: '' };
	const { findByTestId, findByText, queryByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Close Project' });
			const task = await seedTask(ws, project, { title: 'Closable Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.identifier = task.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	// First page render after the shortcut-route redirect can take several
	// seconds under the full-suite fork-pool load on CI runners, well past
	// Testing Library's 1s default.
	const closeButton = await findByTestId('task-close-button', undefined, { timeout: 10_000 });
	await user.click(closeButton);

	const dialog = await findByTestId('confirm-dialog');
	expect(dialog).toBeTruthy();
	await findByText('Close this task?');

	const confirm = await findByTestId('confirm-dialog-confirm');
	await user.click(confirm);

	await findByTestId('task-reopen-button', undefined, { timeout: 5_000 });
	expect(queryByTestId('task-close-button')).toBeNull();

	const reopenButton = await findByTestId('task-reopen-button');
	await user.click(reopenButton);

	await findByText('Re-open this task?');
	const reopenConfirm = await findByTestId('confirm-dialog-confirm');
	await user.click(reopenConfirm);

	await findByTestId('task-close-button', undefined, { timeout: 5_000 });
	expect(queryByTestId('task-reopen-button')).toBeNull();
});

test('task detail no longer shows a delete button or status pill row', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, queryByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'No Delete Project' });
			const task = await seedTask(ws, project, { title: 'Plain Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('task-close-button', undefined, { timeout: 10_000 });
	expect(queryByRole('button', { name: /Delete Task/i })).toBeNull();
	expect(queryByRole('button', { name: 'in progress' })).toBeNull();
	expect(queryByRole('button', { name: 'review' })).toBeNull();
});

test('a done task offers re-open and hides close (done is terminal)', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Done Project' });
			const task = await seedTask(ws, project, { title: 'Done Task' });
			await patchStatus(ws, project.slug, task.id, 'done');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('task-reopen-button', undefined, { timeout: 10_000 });
	expect(queryByTestId('task-close-button')).toBeNull();
});

test('a cancelled task offers re-open and hides close', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Cancelled Project' });
			const task = await seedTask(ws, project, { title: 'Cancelled Task' });
			await patchStatus(ws, project.slug, task.id, 'cancelled');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('task-reopen-button', undefined, { timeout: 10_000 });
	expect(queryByTestId('task-close-button')).toBeNull();
});
