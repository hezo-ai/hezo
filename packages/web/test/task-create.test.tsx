import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

// Proof-of-concept of the component tier: drive the team / project / task
// flow through the real API, render the task list, and assert that the task
// appears. Same realism as the Playwright `task-list` spec but runs against
// an in-process backend with no browser.
test('renders a task with its title and project after seeding', async () => {
	let projectSlug = '';
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo Project' });
			projectSlug = project.slug;
			await seedTask(ws, project, { title: 'Demo Task', description: 'A description.' });
		},
	});

	await router.navigate({ to: '/projects/$projectId/tasks', params: { projectId: projectSlug } });

	await findByText('Demo Task', undefined, { timeout: 10_000 });
});
