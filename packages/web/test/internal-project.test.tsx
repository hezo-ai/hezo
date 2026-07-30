import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

// HQ is the only internal project: the instance-wide coordination project that
// hosts the CEO and Coach. Its slug is HQ_PROJECT_SLUG and `is_internal` is
// true, so it gets the restricted sidebar (no Budget, no Settings) and the
// coordination info tooltip beside its name. It DOES expose Documents and Assets
// — where the CEO saves files it produces for the operator in chat. The settings
// route still redirects to tasks.

test('HQ task list does not show the project progress bar', async () => {
	const { findAllByRole, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: HQ_PROJECT_SLUG },
	});

	await findAllByRole('link', { name: 'Tasks' }, { timeout: 10_000 });
	expect(queryByTestId('task-progress-bar')).toBeNull();
});

test('sidebar exposes Tasks, Documents, Assets and Container for the HQ project (not Settings)', async () => {
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

	// Documents (chatbox memory) and Assets (CEO-produced files) are both exposed
	// for HQ. `is_internal` arrives with the project-meta query, so the link must
	// remain present once the restricted HQ nav settles — wait for that rather
	// than reading synchronously.
	await waitFor(() =>
		expect(queryAllByRole('link', { name: 'Documents' }).length).toBeGreaterThan(0),
	);
	await waitFor(() => expect(queryAllByRole('link', { name: 'Assets' }).length).toBeGreaterThan(0));

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

test('HQ /documents and /assets render while /settings still redirects to /tasks', async () => {
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

	// Assets is a real page for HQ too — the CEO saves operator-facing files here,
	// so the route no longer redirects away.
	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: HQ_PROJECT_SLUG },
	});
	await new Promise((r) => setTimeout(r, 200));
	expect(router.state.location.pathname).toBe(`/projects/${HQ_PROJECT_SLUG}/assets`);

	// Settings still redirects to tasks.
	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: HQ_PROJECT_SLUG },
	});
	await new Promise((r) => setTimeout(r, 200));
	expect(router.state.location.pathname).toBe(`/projects/${HQ_PROJECT_SLUG}/tasks`);

	// So does Concurrency, which discloses under Settings and so has no HQ entry.
	// HQ still gets both limits server-side; it just inherits the globals.
	await router.navigate({
		to: '/projects/$projectId/concurrency',
		params: { projectId: HQ_PROJECT_SLUG },
	});
	await new Promise((r) => setTimeout(r, 200));
	expect(router.state.location.pathname).toBe(`/projects/${HQ_PROJECT_SLUG}/tasks`);
});

test('the HQ assets library lists a file the CEO saved there', async () => {
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await seedWorkspace();
			// Mirror what the CEO does in chat via write_project_asset for off-project
			// work: the deliverable lands in HQ's assets library. (Plain text so the
			// card renders an icon rather than an HTML-preview iframe that would fetch
			// the signed URL and abort on teardown.)
			const { apiBase, token } = getTestContext();
			const fd = new FormData();
			fd.set(
				'file',
				new File(['Recommended Babylon.js for the browser game.'], 'engine-research.txt', {
					type: 'text/plain',
				}),
			);
			const res = await apiBase(`/api/projects/${HQ_PROJECT_SLUG}/assets`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: fd,
			});
			if (!res.ok) throw new Error(`HQ asset upload failed: ${res.status}`);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: HQ_PROJECT_SLUG },
	});

	await findByText('engine-research.txt');
});
