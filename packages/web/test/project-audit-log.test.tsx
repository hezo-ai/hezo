import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('project Activity page lists the project audit trail', async () => {
	const seeded = { projectSlug: '', identifier: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Activity Project' });
			const task = await seedTask(ws, project, { title: 'Audited Task' });
			seeded.projectSlug = project.slug;
			seeded.projectSlug = project.slug;
			seeded.identifier = task.identifier;
			return { ws, project, task };
		},
	});

	await helpers.router.navigate({
		to: '/projects/$projectId/audit-log',
		params: { projectId: seeded.projectSlug },
	});

	// The page mounts (unique description) and the task-created event renders
	// as a row carrying the task identifier.
	await helpers.findByText(/Everything that happened on this project/, undefined, {
		timeout: 20_000,
	});
	await helpers.findByText(new RegExp(seeded.identifier), undefined, { timeout: 20_000 });
	expect(seeded.identifier).toBeTruthy();
}, 30_000);
