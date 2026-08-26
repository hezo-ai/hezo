import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

/**
 * The Team & Budget page's three tabs.
 *
 * Team, Budget and Hours answer different questions - who is on the team, what
 * the agents cost in tokens, and what the containers cost in uptime - so the
 * thing worth pinning is that each tab owns its own URL and its own selected
 * state, and that the old team-page URL still lands on the roster.
 */

/** A closed uptime interval of `minutes`, ending now. */
async function seedUptime(projectId: string, minutes: number): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO container_uptime_entries
		     (project_id, container_id, started_at, ended_at, backend)
		 VALUES ($1, 'ctr-' || gen_random_uuid()::text,
		         now() - ($2::int * interval '1 minute'), now(), 'docker')`,
		[projectId, minutes],
	);
}

/** Insert a finished run of `minutes`, for the per-agent figure on the Spend tab. */
async function seedRun(teamId: string, memberId: string, minutes: number): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, status, started_at, finished_at)
		 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, now(), now() + ($3::int * interval '1 minute'))`,
		[memberId, teamId, minutes],
	);
}

test('the budget index opens on the Budget tab, with only that tab selected', async () => {
	let slug = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Budget Tabs' });
			slug = project.slug;
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: slug } });

	const team = await findByTestId('budget-tab-team');
	const spend = await findByTestId('budget-tab-spend');
	const hours = await findByTestId('budget-tab-hours');
	// The active tab merges into the panel below it (`bg-bg`); an inactive one
	// stays recessed (`bg-surface-2`). Spend is the index route, so a fuzzy match
	// would claim its siblings too - several tabs reading as selected is the bug
	// this asserts against.
	expect(spend.className).toContain('bg-bg');
	for (const inactive of [team, hours]) {
		expect(inactive.className).toContain('bg-surface-2');
		expect(inactive.className).not.toContain('bg-bg');
	}
});

test('the Hours tab reports container uptime as one shared series', async () => {
	let slug = '';
	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Budget Hours' });
			slug = project.slug;
			await seedUptime(project.id, 90);
			await seedUptime(project.id, 30);
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget/hours', params: { projectId: slug } });

	// 90m + 30m = 2h on the month tile. Containers are shared by task runs and
	// chat turns alike, so there is no per-workload split to call out.
	const tiles = await findByTestId('container-hours-tiles');
	expect(tiles.textContent).toContain('2h');
	await findByTestId('container-hours-chart');
	expect(await findByText('Container hours per bucket')).toBeTruthy();
});

test('switching the bucket size refetches the container-hours series', async () => {
	let slug = '';
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Budget Bucket' });
			slug = project.slug;
			await seedUptime(project.id, 45);
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget/hours', params: { projectId: slug } });

	const control = await findByTestId('container-hours-bucket');
	const month = [...control.querySelectorAll('button')].find((b) => b.textContent === 'Month');
	expect(month).toBeTruthy();
	if (month) await user.click(month);

	expect(month?.getAttribute('aria-pressed')).toBe('true');
	await findByTestId('container-hours-chart');
});

test('the Hours tab says so plainly when no container has run', async () => {
	let slug = '';
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Budget Quiet' });
			slug = project.slug;
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget/hours', params: { projectId: slug } });

	expect(await findByText('No container time recorded yet.')).toBeTruthy();
});

test("the Spend tab carries each agent's run time beside its spend", async () => {
	let slug = '';
	let engineerSlug = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Budget Run Time' });
			slug = project.slug;
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			engineerSlug = engineer.slug;
			await seedRun(ws.team.id, engineer.id, 45);
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: slug } });

	// The figure the Activity page's Hours tab used to own, now next to the spend
	// it belongs beside. "Hours" on its own tab means container uptime instead.
	const runTime = await findByTestId(`agent-run-time-${engineerSlug}`);
	expect(runTime.textContent).toContain('45m');
});

test('the Team tab holds the roster: org chart, member cards with chat shortcuts, hire card', async () => {
	let slug = '';
	let agentSlug = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			agentSlug = ws.agents[0].slug;
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget/team', params: { projectId: slug } });

	await findByTestId('team-org-chart');
	const grid = await findByTestId('team-member-grid');
	expect(grid.querySelector(`[data-testid="member-card-${agentSlug}"]`)).toBeTruthy();
	// Roster cards carry a chat shortcut into that agent's DM; the dashed hire
	// card closes the grid on staffable teams.
	expect(grid.querySelector(`[data-testid="member-card-chat-${agentSlug}"]`)).toBeTruthy();
	expect(grid.querySelector('[data-testid="team-hire-card"]')).toBeTruthy();
	// The strip marks Team selected.
	expect((await findByTestId('budget-tab-team')).className).toContain('bg-bg');
});

test('the old team-page URL redirects onto the Team tab', async () => {
	let slug = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
		},
	});

	await router.navigate({ to: '/projects/$projectId/agents', params: { projectId: slug } });

	await findByTestId('team-org-chart');
	expect(router.state.location.pathname).toBe(`/projects/${slug}/budget/team`);
});
