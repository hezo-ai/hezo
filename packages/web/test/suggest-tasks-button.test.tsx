import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

// Component tier (happy-dom): the "Suggest tasks" button on a project's task
// list, against the real server.

async function renderTasks(slugFor: (projectSlug: string) => string) {
	const seeded = { projectSlug: '', projectId: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Suggest Project' });
			seeded.projectSlug = project.slug;
			seeded.projectId = project.id;
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: slugFor(seeded.projectSlug) },
	});
	return { ...helpers, seeded };
}

test('a superuser asks the CEO for suggestions and lands on its suggestions task', async () => {
	const { findByTestId, router, seeded } = await renderTasks((slug) => slug);

	const button = await findByTestId('task-list-suggest-tasks', undefined, { timeout: 15_000 });
	expect(button.getAttribute('aria-label')).toBe('Suggest tasks');
	button.click();

	const { db } = getTestContext();
	await waitFor(
		async () => {
			const r = await db.query<{ identifier: string }>(
				`SELECT identifier FROM tasks WHERE project_id = $1 AND labels @> '["task-suggestions"]'::jsonb`,
				[seeded.projectId],
			);
			expect(r.rows).toHaveLength(1);
			expect(router.state.location.pathname).toBe(
				`/projects/${seeded.projectSlug}/tasks/${r.rows[0].identifier.toLowerCase()}`,
			);
		},
		{ timeout: 15_000 },
	);
});

test('HQ has no Suggest tasks button', async () => {
	const { findByTestId, queryByTestId } = await renderTasks(() => 'hq');

	await findByTestId('task-list-new-task', undefined, { timeout: 15_000 });
	expect(queryByTestId('task-list-suggest-tasks')).toBeNull();
});
