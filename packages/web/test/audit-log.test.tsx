import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('project Activity page exposes the Outbound traffic (egress) tab', async () => {
	const seeded = { projectSlug: '' };
	const { findByRole, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.projectSlug = ws.internalSlug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/audit-log',
		params: { projectId: seeded.projectSlug },
	});

	await findByRole('heading', { name: 'Activity' }, { timeout: 10_000 });

	// Switching to the egress tab swaps in its description and empty state.
	await user.click(await findByRole('button', { name: 'Outbound traffic' }));
	await findByText(/Every outbound HTTPS request/, undefined, { timeout: 10_000 });
	expect(await findByText(/No outbound traffic recorded yet/)).toBeTruthy();
});
