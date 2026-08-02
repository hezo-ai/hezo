import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedGoal, seedProject, seedWorkspace } from './helpers/seed';

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
	expect(within(nav).getByRole('link', { name: 'Settings' })).toBeTruthy();
	// Git, Container and Activity now nest under Settings — hidden until it (or
	// one of them) is the active route.
	expect(within(nav).queryByRole('link', { name: 'Git' })).toBeNull();
	expect(within(nav).queryByRole('link', { name: 'Container' })).toBeNull();
	expect(within(nav).queryByRole('link', { name: 'Activity' })).toBeNull();

	// A Team section lists the team's agents (presented as the project's own).
	expect(within(nav).getByRole('link', { name: 'Team' })).toBeTruthy();
	await waitFor(() => expect(within(nav).getByRole('link', { name: /Captain/ })).toBeTruthy(), {
		timeout: 20_000,
	});

	// No cross-project landing affordances.
	expect(within(nav).queryByRole('link', { name: 'All Projects' })).toBeNull();
	expect(queryByTestId('project-sidebar-back')).toBeNull();
});

test('Git, Container and Activity nest under Settings, disclosed when Settings is the active route', async () => {
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

	// On a non-settings page the sub-items stay collapsed.
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});
	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });
	expect(within(getNav(container)).queryByRole('link', { name: 'Git' })).toBeNull();
	expect(within(getNav(container)).queryByRole('link', { name: 'Container' })).toBeNull();
	expect(within(getNav(container)).queryByRole('link', { name: 'Activity' })).toBeNull();

	// Selecting Settings discloses Git, Container and Activity beneath it.
	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});
	await waitFor(() =>
		expect(within(getNav(container)).getByRole('link', { name: 'Git' })).toBeTruthy(),
	);
	expect(within(getNav(container)).getByRole('link', { name: 'Container' })).toBeTruthy();
	expect(within(getNav(container)).getByRole('link', { name: 'Activity' })).toBeTruthy();
	expect(within(getNav(container)).getByRole('link', { name: 'Settings' })).toBeTruthy();

	// Clicking into Container keeps the disclosure open — its route doesn't
	// fuzzy-match Settings, so a parent-only check would collapse it on navigation.
	await router.navigate({
		to: '/projects/$projectId/container',
		params: { projectId: projectSlug },
	});
	await waitFor(() =>
		expect(within(getNav(container)).getByRole('link', { name: 'Activity' })).toBeTruthy(),
	);
	expect(within(getNav(container)).getByRole('link', { name: 'Container' })).toBeTruthy();
});

test('the Team section is always expanded — no collapse/expand toggle', async () => {
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
	await waitFor(() => expect(within(getNav(container)).queryByText('Captain')).toBeTruthy(), {
		timeout: 20_000,
	});

	// The agent list is permanently visible — the collapse/expand affordance is gone.
	expect(within(getNav(container)).queryByRole('button', { name: 'Collapse' })).toBeNull();
	expect(within(getNav(container)).queryByRole('button', { name: 'Expand' })).toBeNull();
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

test('Team agents use a pulsing live dot for running and no dot when idle', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	let runningTitle = '';
	const { container, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Operations' });
			projectSlug = project.slug;
			// Drive Captain (an own agent, always present) into the running state.
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			runningTitle = captain.title;
			await getTestContext().db.query(
				`UPDATE member_agents SET runtime_status = 'active'::agent_runtime_status WHERE id = $1`,
				[captain.id],
			);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});
	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });
	const nav = getNav(container);

	// The "idle"/"running" text suffixes are gone — status is a dot now.
	await waitFor(() => expect(within(nav).getByRole('link', { name: /Captain/ })).toBeTruthy(), {
		timeout: 20_000,
	});
	expect(within(nav).queryByText('idle')).toBeNull();
	expect(within(nav).queryByText('running')).toBeNull();

	// The running agent shows a pulsing cyan "live" dot; idle agents show none.
	await waitFor(() => expect(within(nav).getByRole('img', { name: 'Running' })).toBeTruthy(), {
		timeout: 20_000,
	});
	const runningDot = within(nav).getByRole('img', { name: 'Running' });
	expect(runningDot.className).toContain('bg-live');
	expect(runningDot.className).toContain('animate-pulse');
	expect(within(nav).queryByRole('img', { name: 'Idle' })).toBeNull();

	// The running agent keeps the bold-name emphasis.
	const runningLink = within(nav).getByRole('link', { name: new RegExp(runningTitle) });
	expect(within(runningLink).getByText(runningTitle).className).toContain('font-semibold');
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

test('the Progress nav item shows the "no goals yet" dot only until the project has a goal', async () => {
	// Two projects need two workspaces — a team backs exactly one project (1:1).
	let emptySlug = '';
	let withGoalSlug = '';
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const emptyWs = await seedWorkspace();
			const empty = await seedProject(emptyWs, { name: 'No Goals Yet' });
			emptySlug = empty.slug;

			const goalWs = await seedWorkspace();
			const withGoal = await seedProject(goalWs, { name: 'Has A Goal' });
			withGoalSlug = withGoal.slug;
			await seedGoal(goalWs, withGoal, { title: 'Ship the beta', measurement: 'beta is live' });
		},
	});

	// A project with no goals surfaces the prompting dot.
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: emptySlug },
	});
	await findByTestId('project-sidebar-goals-empty-dot', undefined, { timeout: 15_000 });

	// A project that already has a goal must NOT show it — open_goal_count flows from the
	// project index, so the dot clears for projects with goals (regression: it always showed).
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: withGoalSlug },
	});
	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });
	await waitFor(() => expect(queryByTestId('project-sidebar-goals-empty-dot')).toBeNull(), {
		timeout: 15_000,
	});
});

test('creating a goal clears the sidebar "no goals yet" dot', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const { findByTestId, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Goal Creation' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});
	// The dot is present while the project has no goals.
	await findByTestId('project-sidebar-goals-empty-dot', undefined, { timeout: 15_000 });

	// Create a goal from the Progress page's "New goal" button. The sidebar persists across
	// project routes, so its dot reflects the new goal once the project index invalidates.
	await router.navigate({
		to: '/projects/$projectId/progress/goals',
		params: { projectId: projectSlug },
	});
	await user.click(await findByTestId('goals-empty-create', undefined, { timeout: 15_000 }));
	// The dialog renders into a portal on document.body; the name field has an explicit id.
	const nameInput = await waitFor(() => {
		const el = document.body.querySelector<HTMLInputElement>('#goal-name');
		if (!el) throw new Error('goal-name input not mounted');
		return el;
	});
	await user.type(nameInput, 'Reach 100 customers');
	await user.click(within(document.body).getByRole('button', { name: 'Create' }));

	// Creating a goal invalidates the project index, so the dot clears without a manual refresh.
	await waitFor(() => expect(queryByTestId('project-sidebar-goals-empty-dot')).toBeNull(), {
		timeout: 15_000,
	});
});

test('the Container nav item shows a provisioning spinner while the container is creating', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Operations' });
			projectSlug = project.slug;
			// A container mid-provision: the sidebar should surface a live spinner.
			await getTestContext().db.query(
				`UPDATE projects SET container_status = 'creating'::container_status WHERE id = $1`,
				[project.id],
			);
		},
	});

	// The Container item discloses on its own route; its label carries the spinner.
	await router.navigate({
		to: '/projects/$projectId/container',
		params: { projectId: projectSlug },
	});
	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });

	const spinner = await findByTestId('project-sidebar-container-spinner', undefined, {
		timeout: 15_000,
	});
	expect(spinner.className).toContain('animate-spin');
	expect(spinner.className).toContain('text-info');
	// Provisioning is not a failure — no error indicator alongside it.
	expect(queryByTestId('project-sidebar-container-error')).toBeNull();
});

test('the Container nav item shows no spinner once the container is running', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const { container, findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Operations' });
			projectSlug = project.slug;
			await getTestContext().db.query(
				`UPDATE projects SET container_status = 'running'::container_status,
				        container_id = COALESCE(container_id, 'c1') WHERE id = $1`,
				[project.id],
			);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/container',
		params: { projectId: projectSlug },
	});
	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });

	// Once the Container item is disclosed (and healthy), no spinner or error icon.
	const nav = getNav(container);
	await waitFor(() => expect(within(nav).getByRole('link', { name: 'Container' })).toBeTruthy(), {
		timeout: 15_000,
	});
	expect(queryByTestId('project-sidebar-container-spinner')).toBeNull();
	expect(queryByTestId('project-sidebar-container-error')).toBeNull();
});
