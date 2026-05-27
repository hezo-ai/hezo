import { test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('audit log page renders at the dedicated route', async () => {
	const seeded = { teamSlug: '' };
	const { findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/settings/audit-log',
		params: { teamId: seeded.teamSlug },
	});

	await findByRole('heading', { name: 'Audit log' }, { timeout: 10_000 });
});
