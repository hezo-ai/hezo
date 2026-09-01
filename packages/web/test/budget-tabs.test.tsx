import { seedMonthToDateSeconds } from '@hezo/server/test/helpers/uptime';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

/**
 * The Budget page's two tabs, and what became of the Activity page's.
 *
 * Spend and Hours answer different questions - what the agents cost in tokens,
 * and what the containers cost in uptime - so the thing worth pinning is that
 * each tab owns its own URL and its own selected state. Activity, which used to
 * carry a tab strip of its own, is asserted to have none.
 */

/**
 * `minutes` of closed container time banked so far this month.
 *
 * Not one interval `minutes` long: the tiles below read a month-to-date figure,
 * and on the first hour of a month a stretch that far back is mostly last
 * month's - which is what the meter would rightly report, leaving every fixed
 * expectation here short.
 */
async function seedUptime(projectId: string, minutes: number, chat = false): Promise<void> {
	const { db } = getTestContext();
	await seedMonthToDateSeconds(db, minutes * 60, { projectId, chat });
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

test('Budget opens on Spend, with only that tab selected', async () => {
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

	const spend = await findByTestId('budget-tab-spend');
	const hours = await findByTestId('budget-tab-hours');
	// The active tab merges into the panel below it (`bg-bg`); an inactive one
	// stays recessed (`bg-surface-2`). Spend is the index route, so a fuzzy match
	// would claim `/hours` too - both tabs reading as selected is the bug this
	// asserts against.
	expect(spend.className).toContain('bg-bg');
	expect(hours.className).toContain('bg-surface-2');
	expect(hours.className).not.toContain('bg-bg');
});

test('the Hours tab reports container uptime, split into task and chat time', async () => {
	let slug = '';
	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Budget Hours' });
			slug = project.slug;
			await seedUptime(project.id, 90);
			await seedUptime(project.id, 30, true);
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget/hours', params: { projectId: slug } });

	// 90m task + 30m chat = 2h on the month tile, with the chat share called out
	// separately - it is inside the total, not beside it.
	const tiles = await findByTestId('container-hours-tiles');
	expect(tiles.textContent).toContain('2h');
	expect(tiles.textContent).toContain('30m');
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

test('Activity renders its log with no tab strip', async () => {
	let slug = '';
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
		},
	});

	await router.navigate({ to: '/projects/$projectId/activity', params: { projectId: slug } });

	await findByText('Everything that happened on this project, newest first.');
	// The per-agent hours tab is gone, so the strip that switched to it is too.
	expect(document.querySelector('[data-testid="activity-tab-log"]')).toBeNull();
	expect(document.querySelector('[data-testid="activity-tab-hours"]')).toBeNull();
});
