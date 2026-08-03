// Before the first project is created, the app lands on /home, which has no
// project-scoped route. The persistent project menu (ProjectSidebar) used to be
// gated purely on a route-active project, so it never rendered on /home and the
// operator could not view or expand the HQ menu at all - including the marker
// that says HQ's container failed. The shell now falls back to HQ as the menu's
// project while there are zero visible projects.
//
// Component tier: the menu's presence is conditional-rendering logic (does the
// panel mount), not a real-layout/viewport assertion — happy-dom mounts the
// `hidden lg:block` panel into the DOM so its testids are queryable. Only HQ
// exists here (created by createTestApp; no seedWorkspace), which is exactly the
// "no project created" state.

import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('the HQ menu is viewable on /home when no project has been created', async () => {
	const { findByTestId, findAllByRole } = await renderApp({ initialPath: '/home' });

	// The persistent menu panel renders (previously absent on /home), showing the
	// HQ project's own menu: its name link, the coordination info tooltip that
	// marks the internal HQ shape, and the Containers link the user needs.
	await findByTestId('project-menu', undefined, { timeout: 15_000 });
	await findByTestId('project-sidebar-name');
	await findByTestId('project-sidebar-info');
	const containerLinks = await findAllByRole('link', { name: 'Containers' });
	expect(containerLinks.length).toBeGreaterThan(0);
});

test('the HQ menu surfaces the container failure indicator on /home', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		// The reported scenario: HQ's container failed to provision. The default
		// harness marks it running, so flip it to error before mount.
		seed: async (ctx) => {
			await ctx.db.query(`UPDATE projects SET container_status = 'error' WHERE is_internal = true`);
		},
	});

	// The Containers item in the HQ menu shows its failure marker, so the operator
	// knows to go and look - the whole point of reaching the menu here.
	await findByTestId('project-sidebar-container-error', undefined, { timeout: 15_000 });
});

test('/home shows no project menu once a project exists (menu follows the route)', async () => {
	const { findByTestId, queryByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
		},
	});

	// Home has loaded its project dashboard...
	await findByTestId('home-projects', undefined, { timeout: 15_000 });
	// ...and the fallback does NOT fire: with a visible project, /home stays
	// menu-less (the menu only appears on a project-scoped route).
	await waitFor(() => {
		expect(queryByTestId('project-menu')).toBeNull();
		expect(queryByTestId('project-sidebar-name')).toBeNull();
	});
});
