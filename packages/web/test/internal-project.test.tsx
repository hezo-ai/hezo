import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('sidebar exposes only Tasks and Container for the internal project', async () => {
	const seeded = { projectSlug: '' };
	const { findAllByRole, queryAllByRole, container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.projectSlug = ws.internalSlug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: seeded.projectSlug },
	});

	// Wait for the project-scoped nav (incl. Container link, which only
	// renders after the projects query resolves) to render.
	const containerLinks = await findAllByRole('link', { name: 'Container' });
	expect(containerLinks.length).toBeGreaterThan(0);

	const tasksLinks = queryAllByRole('link', { name: 'Tasks' });
	expect(tasksLinks.length).toBeGreaterThan(0);

	// Documents/Assets are dropped once the index resolves the project as internal.
	await waitFor(() => expect(queryAllByRole('link', { name: 'Documents' }).length).toBe(0));

	// No settings link pointing at the internal project.
	const settingsLinks = queryAllByRole('link', { name: 'Settings' });
	for (const link of settingsLinks) {
		const href = link.getAttribute('href') ?? '';
		expect(href.includes(`/projects/${seeded.projectSlug}/settings`)).toBe(false);
	}
	expect(container.querySelector('nav')).toBeTruthy();
});

test('banner appears on internal-project landing pages', async () => {
	const seeded = { projectSlug: '' };
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.projectSlug = ws.internalSlug;
		},
	});

	const bannerCopy =
		'Internal team coordination project, used for onboarding and team-level changes.';

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: seeded.projectSlug },
	});
	await findByText(bannerCopy, undefined, { timeout: 10_000 });

	await router.navigate({
		to: '/projects/$projectId/container',
		params: { projectId: seeded.projectSlug },
	});
	await findByText(bannerCopy, undefined, { timeout: 10_000 });
});

test('direct navigation to /documents and /settings redirects to /tasks', async () => {
	const seeded = { projectSlug: '' };
	const { router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.projectSlug = ws.internalSlug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: seeded.projectSlug },
	});
	await new Promise((r) => setTimeout(r, 200));
	expect(router.state.location.pathname).toBe(`/projects/${seeded.projectSlug}/tasks`);

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: seeded.projectSlug },
	});
	await new Promise((r) => setTimeout(r, 200));
	expect(router.state.location.pathname).toBe(`/projects/${seeded.projectSlug}/tasks`);
});
