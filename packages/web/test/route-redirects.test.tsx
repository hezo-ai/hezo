import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('invalid team slug redirects to /home', async () => {
	const { router, findByText } = await renderApp({
		initialPath: '/teams/does-not-exist-abc123/tasks',
		seed: async () => {
			// Seed a real team so /home renders normally after the redirect.
			await seedWorkspace();
		},
	});

	// The /teams/:teamId loader sees a 404 from the team query and effects
	// navigate({ to: '/home', replace: true }). Wait for that to land.
	await findByText(/Welcome to Hezo|Get started|Home/i, undefined, { timeout: 10_000 });
	expect(router.state.location.pathname).toBe('/home');
});
