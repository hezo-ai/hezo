import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

// HQ is the only internal project: the instance-wide coordination project that
// hosts the CEO and Coach. Its slug is HQ_PROJECT_SLUG and `is_internal` is
// true, so it gets the restricted sidebar (no Assets, no Settings) and the
// coordination info tooltip beside its name. It DOES expose Documents — that's
// where the chatbox memory (chat-memory.md) is viewed/edited — and the settings
// route still redirects to tasks.

test('sidebar exposes Tasks, Documents and Container for the HQ project (not Assets/Settings)', async () => {
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

	// Documents is exposed for HQ (the chatbox memory lives here); Assets is not.
	await waitFor(() =>
		expect(queryAllByRole('link', { name: 'Documents' }).length).toBeGreaterThan(0),
	);
	expect(queryAllByRole('link', { name: 'Assets' }).length).toBe(0);

	// No settings link pointing at the HQ project.
	const settingsLinks = queryAllByRole('link', { name: 'Settings' });
	for (const link of settingsLinks) {
		const href = link.getAttribute('href') ?? '';
		expect(href.includes(`/projects/${HQ_PROJECT_SLUG}/settings`)).toBe(false);
	}
	expect(container.querySelector('nav')).toBeTruthy();
});

test('coordination info tooltip sits beside the HQ name', async () => {
	const { findByTestId, getAllByText, user, router } = await renderApp({
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
			getAllByText(
				'Internal team coordination project, used for onboarding and team-level changes.',
			).length,
		).toBeGreaterThan(0),
	);
});

test('HQ /documents renders (chatbox memory) while /settings still redirects to /tasks', async () => {
	const { router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await seedWorkspace();
		},
	});

	// Documents is a real page for HQ now — no redirect.
	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: HQ_PROJECT_SLUG },
	});
	await new Promise((r) => setTimeout(r, 200));
	expect(router.state.location.pathname).toBe(`/projects/${HQ_PROJECT_SLUG}/documents`);

	// Settings still redirects to tasks.
	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: HQ_PROJECT_SLUG },
	});
	await new Promise((r) => setTimeout(r, 200));
	expect(router.state.location.pathname).toBe(`/projects/${HQ_PROJECT_SLUG}/tasks`);
});
