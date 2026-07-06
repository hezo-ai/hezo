import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('the task meta panel shows the task status (read-only) above priority', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, getByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Status Project' });
			const task = await seedTask(ws, project, { title: 'Statusable Task' });
			// Move it off the default backlog so we can assert the panel reflects the real status.
			const { apiBase } = getTestContext();
			await apiBase(`/api/projects/${project.slug}/tasks/${task.id}`, {
				method: 'PATCH',
				headers: ws.headers,
				body: JSON.stringify({ status: 'in_progress' }),
			});
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const status = await findByTestId('task-status', undefined, { timeout: 10_000 });
	expect(status.textContent).toBe('In Progress');

	// The status is display-only — there must be no editable control for it.
	expect(queryByTestId('task-status-select')).toBeNull();
	expect(status.tagName).not.toBe('SELECT');
	expect(status.querySelector('select')).toBeNull();

	// It renders above the Priority control in the sidebar's DOM order.
	const sidebar = getByTestId('task-sidebar');
	const priorityLabel = Array.from(sidebar.querySelectorAll('span')).find(
		(el) => el.textContent === 'Priority',
	);
	expect(priorityLabel).toBeTruthy();
	expect(
		status.compareDocumentPosition(priorityLabel as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
});
