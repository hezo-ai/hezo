import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('the admin can close and re-open a task via themed modal', async () => {
	const seeded = { teamSlug: '', taskId: '', identifier: '' };
	const { findByTestId, findByText, queryByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Close Project' });
			const task = await seedTask(ws, project, { title: 'Closable Task' });
			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
			seeded.identifier = task.identifier;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
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
	const seeded = { teamSlug: '', taskId: '' };
	const { findByTestId, queryByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'No Delete Project' });
			const task = await seedTask(ws, project, { title: 'Plain Task' });
			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
	});

	await findByTestId('task-close-button', undefined, { timeout: 10_000 });
	expect(queryByRole('button', { name: /Delete Task/i })).toBeNull();
	expect(queryByRole('button', { name: 'in progress' })).toBeNull();
	expect(queryByRole('button', { name: 'review' })).toBeNull();
});
