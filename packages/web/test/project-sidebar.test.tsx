import { within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

function getNav(container: HTMLElement): HTMLElement {
	const nav = container.querySelector('nav[aria-label="Sidebar"]');
	if (!nav) throw new Error('nav not mounted');
	return nav as HTMLElement;
}

test('inside a project, the sidebar is project-scoped with a secondary Team section', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const { container, findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Operations' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks',
		params: { teamId: ws.team.slug, projectId: projectSlug },
	});

	// Project name header renders, and the project's own pages are the primary nav.
	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });
	const nav = getNav(container);
	expect(within(nav).getByRole('link', { name: 'Documents' })).toBeTruthy();
	expect(within(nav).getByRole('link', { name: 'Assets' })).toBeTruthy();
	expect(within(nav).getByRole('link', { name: 'Container' })).toBeTruthy();

	// The team it belongs to is a secondary section, not the primary axis.
	expect(within(nav).getByText('Team', { exact: true })).toBeTruthy();
	expect(within(nav).getByRole('link', { name: 'All Projects' })).toBeTruthy();
	// The team-scoped "Projects" section header is absent in project scope.
	expect(within(nav).queryByText('Projects', { exact: true })).toBeNull();

	// The back link returns to the team's project list.
	await user.click(await findByTestId('project-sidebar-back'));
	expect(router.state.location.pathname).toBe(`/teams/${ws.team.slug}/projects`);
});

test('team-level routes keep the team-scoped sidebar', async () => {
	let ws!: SeededWorkspace;
	const { container, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({ to: '/teams/$teamId/tasks', params: { teamId: ws.team.slug } });
	await findByText('Resources', undefined, { timeout: 15_000 });

	const nav = getNav(container);
	// Team sidebar has the "Projects" section; the project header is absent.
	expect(within(nav).getByText('Projects', { exact: true })).toBeTruthy();
	expect(container.querySelector('[data-testid="project-sidebar-name"]')).toBeNull();
});
