import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

test('invalid team slug redirects to /home', async () => {
	const { router } = await renderApp({
		initialPath: '/teams/does-not-exist-abc123/tasks',
		seed: async () => {
			// Seed a real team + named project so /home renders its projects list
			// after the redirect (the 1:1 model means a seeded team always has a
			// project, so Home shows the list, not the welcome card).
			const ws = await seedWorkspace();
			await seedProject(ws, { name: 'Redirect Target' });
		},
	});

	// The /teams/:teamId loader sees a 404 from the team query and effects
	// navigate({ to: '/home', replace: true }). Wait for Home's projects-list
	// section to mount — a stable element only present once the redirect has
	// resolved and Home has rendered. Scope to main (the rail also has a New
	// project affordance).
	await waitFor(
		async () => {
			const main = document.querySelector('main');
			if (!main) throw new Error('main not mounted');
			return within(main as HTMLElement).getByTestId('home-projects');
		},
		{ timeout: 10_000 },
	);
	expect(router.state.location.pathname).toBe('/home');
});
