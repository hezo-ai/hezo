import { test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('global All Tasks aggregates tasks across the user teams', async () => {
	const { findByText, findByTestId, findByRole } = await renderApp({
		initialPath: '/home/tasks',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Alpha Proj' });
			await seedTask(ws, project, { title: 'Global Alpha Task' });
		},
	});

	// Page heading (the sidebar also has an "All Tasks" link, so target the heading).
	await findByRole('heading', { name: 'All Tasks' });
	await findByTestId('all-tasks-list');
	await findByText(/Global Alpha Task/);
});
