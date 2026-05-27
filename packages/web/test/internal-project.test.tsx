import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('project list renders (Internal) with italic class', async () => {
	const seeded = { teamSlug: '' };
	const { findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects',
		params: { teamId: seeded.teamSlug },
	});

	const heading = await findByRole('heading', { name: '(Internal)' }, { timeout: 10_000 });
	expect(heading.className).toContain('italic');
});

test('sidebar exposes only Tasks and Container for the internal project', async () => {
	const seeded = { teamSlug: '' };
	const { findAllByRole, queryAllByRole, container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks',
		params: { teamId: seeded.teamSlug, projectId: 'internal' },
	});

	// Wait for the project-scoped nav to render.
	const tasksLinks = await findAllByRole('link', { name: 'Tasks' });
	expect(tasksLinks.length).toBeGreaterThan(0);

	const containerLinks = queryAllByRole('link', { name: 'Container' });
	expect(containerLinks.length).toBeGreaterThan(0);

	const docsLinks = queryAllByRole('link', { name: 'Documents' });
	expect(docsLinks.length).toBe(0);

	// No settings link pointing at the internal project.
	const settingsLinks = queryAllByRole('link', { name: 'Settings' });
	for (const link of settingsLinks) {
		const href = link.getAttribute('href') ?? '';
		expect(href.includes('/projects/internal/settings')).toBe(false);
	}
	// Sanity check we actually have the rendered nav.
	expect(container.querySelector('nav')).toBeTruthy();
});

test('banner appears on internal-project landing pages', async () => {
	const seeded = { teamSlug: '' };
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.teamSlug = ws.team.slug;
		},
	});

	const bannerCopy =
		'Internal team coordination project, used for onboarding and team-level changes.';

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks',
		params: { teamId: seeded.teamSlug, projectId: 'internal' },
	});
	await findByText(bannerCopy, undefined, { timeout: 10_000 });

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/container',
		params: { teamId: seeded.teamSlug, projectId: 'internal' },
	});
	await findByText(bannerCopy, undefined, { timeout: 10_000 });
});

test('direct navigation to /documents and /settings redirects to /tasks', async () => {
	const seeded = { teamSlug: '' };
	const { router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/documents',
		params: { teamId: seeded.teamSlug, projectId: 'internal' },
	});
	// Allow the redirect to land.
	await new Promise((r) => setTimeout(r, 200));
	expect(router.state.location.pathname).toMatch(
		new RegExp(`/teams/${seeded.teamSlug}/projects/internal/tasks`),
	);

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/settings',
		params: { teamId: seeded.teamSlug, projectId: 'internal' },
	});
	await new Promise((r) => setTimeout(r, 200));
	expect(router.state.location.pathname).toMatch(
		new RegExp(`/teams/${seeded.teamSlug}/projects/internal/tasks`),
	);
});
