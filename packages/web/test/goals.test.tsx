import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

// Component-tier proof for the Goals page: seed a team + project (no goals),
// navigate to the goals route, and assert the empty-state hero renders with its
// exact tagline. No goal seeder exists, so the empty path is what we assert.
test('renders the goals empty state when a project has no goals', async () => {
	let projectSlug = '';
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Goals Demo' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	await findByText('Create the first goal for the team to work towards', undefined, {
		timeout: 10_000,
	});
});
