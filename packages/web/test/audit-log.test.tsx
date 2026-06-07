import { test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('audit log page renders at the dedicated route', async () => {
	const seeded = { projectSlug: '' };
	const { findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.projectSlug = ws.internalSlug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/team-settings/audit-log',
		params: { projectId: seeded.projectSlug },
	});

	await findByRole('heading', { name: 'Audit log' }, { timeout: 10_000 });
});
