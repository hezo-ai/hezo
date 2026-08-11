import { waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

const COLLAPSED_KEY = 'hezo:projectMenuCollapsed';

// The persisted collapse state leaks across tests in this file (localStorage is
// shared within the happy-dom environment), so reset it before each.
beforeEach(() => {
	try {
		localStorage.clear();
	} catch {
		// storage unavailable — ignore
	}
});

test('collapsing hides the project menu and docks an expand tab to the rail; expanding restores it', async () => {
	let projectSlug = '';
	const { findByTestId, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws: SeededWorkspace = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Operations' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	// Expanded by default: the menu is shown with a collapse control, no expand tab.
	await findByTestId('project-sidebar-dashboard', undefined, { timeout: 15_000 });
	expect(queryByTestId('project-sidebar-expand')).toBeNull();
	const collapse = await findByTestId('project-sidebar-collapse');

	// Collapse → the whole menu unmounts and the rail-docked expand tab appears,
	// and the choice is persisted.
	await user.click(collapse);
	await findByTestId('project-sidebar-expand', undefined, { timeout: 15_000 });
	await waitFor(() => expect(queryByTestId('project-sidebar-dashboard')).toBeNull());
	expect(localStorage.getItem(COLLAPSED_KEY)).toBe('1');

	// Expand → the menu returns, the tab is gone, and the persisted flag clears.
	await user.click(await findByTestId('project-sidebar-expand'));
	await findByTestId('project-sidebar-dashboard', undefined, { timeout: 15_000 });
	expect(queryByTestId('project-sidebar-expand')).toBeNull();
	expect(localStorage.getItem(COLLAPSED_KEY)).toBe('0');
});

test('a persisted collapsed state renders collapsed on first paint', async () => {
	localStorage.setItem(COLLAPSED_KEY, '1');

	let projectSlug = '';
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws: SeededWorkspace = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Operations' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	// It comes up collapsed: the expand tab is present and the menu is absent.
	await findByTestId('project-sidebar-expand', undefined, { timeout: 15_000 });
	expect(queryByTestId('project-sidebar-dashboard')).toBeNull();
});
