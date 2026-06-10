import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

function getNav(container: HTMLElement): HTMLElement {
	const nav = container.querySelector('nav[aria-label="Sidebar"]');
	if (!nav) throw new Error('nav not mounted');
	return nav as HTMLElement;
}

test('the project menu leads with Inbox, lists the project pages, and has a Team section of agents', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const { container, findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Operations' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });
	const nav = getNav(container);

	// Inbox leads; the project pages follow.
	expect(within(nav).getByRole('link', { name: 'Inbox' })).toBeTruthy();
	expect(within(nav).getByRole('link', { name: 'Documents' })).toBeTruthy();
	expect(within(nav).getByRole('link', { name: 'Assets' })).toBeTruthy();
	expect(within(nav).getByRole('link', { name: 'Container' })).toBeTruthy();

	// A Team section lists the team's agents (presented as the project's own).
	expect(within(nav).getByRole('link', { name: 'Team' })).toBeTruthy();
	await waitFor(() => expect(within(nav).getByRole('link', { name: /Captain/ })).toBeTruthy(), {
		timeout: 20_000,
	});

	// No cross-project landing affordances.
	expect(within(nav).queryByRole('link', { name: 'All Projects' })).toBeNull();
	expect(queryByTestId('project-sidebar-back')).toBeNull();
});

test('the Team section collapses and expands, hiding the agent list', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const { container, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Operations' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});
	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });
	await waitFor(() => expect(within(getNav(container)).queryByText('Captain')).toBeTruthy(), {
		timeout: 20_000,
	});

	const collapse = within(getNav(container)).getByRole('button', { name: 'Collapse' });
	await user.click(collapse);
	await waitFor(() => expect(within(getNav(container)).queryByText('Captain')).toBeNull());

	const expand = within(getNav(container)).getByRole('button', { name: 'Expand' });
	await user.click(expand);
	await waitFor(() => expect(within(getNav(container)).queryByText('Captain')).toBeTruthy());
});

test('HQ agents appear in the Team section as global members linking to the HQ project', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const { container, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Operations' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});
	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });

	// The CEO (an HQ agent) surfaces as a virtual member linking to its HQ page.
	const nav = getNav(container);
	await waitFor(() => expect(within(nav).getByRole('link', { name: /CEO/ })).toBeTruthy(), {
		timeout: 20_000,
	});
	const link = within(nav).getByRole('link', { name: /CEO/ });
	expect(link.getAttribute('href')).toBe('/projects/hq/agents/ceo');
});

test("the project menu persists across the project's team pages and disappears off-project", async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const { container, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Operations' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId',
		params: { projectId: projectSlug },
	});
	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });

	// The Team header links to the agents page, nested under the project.
	await user.click(within(getNav(container)).getByRole('link', { name: 'Team' }));
	await waitFor(() =>
		expect(router.state.location.pathname).toBe(`/projects/${projectSlug}/agents`),
	);
	// The menu stays — the route still carries the project.
	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });

	// Going to the cross-team home drops the menu (full-width content).
	await router.navigate({ to: '/home' });
	await waitFor(() =>
		expect(container.querySelector('[data-testid="project-sidebar-name"]')).toBeNull(),
	);
});
