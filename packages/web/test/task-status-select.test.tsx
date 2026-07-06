import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('the task meta panel exposes a status select above priority that updates the task', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, getByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Status Project' });
			const task = await seedTask(ws, project, { title: 'Statusable Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const statusSelect = (await findByTestId('task-status-select', undefined, {
		timeout: 10_000,
	})) as HTMLSelectElement;

	// A freshly-seeded task starts in the backlog.
	expect(statusSelect.value).toBe('backlog');

	// The status control sits above priority in the sidebar's DOM order.
	const sidebar = getByTestId('task-sidebar');
	const priorityLabel = Array.from(sidebar.querySelectorAll('span')).find(
		(el) => el.textContent === 'Priority',
	);
	expect(priorityLabel).toBeTruthy();
	expect(
		statusSelect.compareDocumentPosition(priorityLabel as HTMLElement) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();

	// Changing the status is response-driven — the select reflects the new value
	// once the server confirms.
	await user.selectOptions(statusSelect, 'in_progress');
	await waitFor(() => {
		expect((getByTestId('task-status-select') as HTMLSelectElement).value).toBe('in_progress');
	});
});
