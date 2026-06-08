import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

// HQ is the only internal project: the instance-wide coordination project that
// hosts the CEO and Coach. Its slug is HQ_PROJECT_SLUG and `is_internal` is
// true, so it gets the restricted sidebar, the coordination info tooltip beside
// its name, and the documents/settings redirects.

test('sidebar exposes only Tasks and Container for the HQ project', async () => {
	const { findAllByRole, queryAllByRole, container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: HQ_PROJECT_SLUG },
	});

	// Wait for the project-scoped nav (incl. Container link, which only
	// renders after the projects query resolves) to render.
	const containerLinks = await findAllByRole('link', { name: 'Container' });
	expect(containerLinks.length).toBeGreaterThan(0);

	const tasksLinks = queryAllByRole('link', { name: 'Tasks' });
	expect(tasksLinks.length).toBeGreaterThan(0);

	// Documents/Assets are dropped once the index resolves the project as internal.
	await waitFor(() => expect(queryAllByRole('link', { name: 'Documents' }).length).toBe(0));

	// No settings link pointing at the HQ project.
	const settingsLinks = queryAllByRole('link', { name: 'Settings' });
	for (const link of settingsLinks) {
		const href = link.getAttribute('href') ?? '';
		expect(href.includes(`/projects/${HQ_PROJECT_SLUG}/settings`)).toBe(false);
	}
	expect(container.querySelector('nav')).toBeTruthy();
});

test('coordination info tooltip sits beside the HQ name', async () => {
	const { findByTestId, getByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: HQ_PROJECT_SLUG },
	});

	const info = await findByTestId('project-sidebar-info', undefined, { timeout: 10_000 });
	await user.hover(info);

	await waitFor(() =>
		expect(
			getByText('Internal team coordination project, used for onboarding and team-level changes.'),
		).toBeTruthy(),
	);
});

test('direct navigation to /documents and /settings redirects to /tasks', async () => {
	const { router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: HQ_PROJECT_SLUG },
	});
	await new Promise((r) => setTimeout(r, 200));
	expect(router.state.location.pathname).toBe(`/projects/${HQ_PROJECT_SLUG}/tasks`);

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: HQ_PROJECT_SLUG },
	});
	await new Promise((r) => setTimeout(r, 200));
	expect(router.state.location.pathname).toBe(`/projects/${HQ_PROJECT_SLUG}/tasks`);
});
