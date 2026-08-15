import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

/** Insert a finished run of `minutes` for `memberId`, starting today. */
async function seedRun(teamId: string, memberId: string, minutes: number): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, status, started_at, finished_at)
		 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, now(), now() + ($3::int * interval '1 minute'))`,
		[memberId, teamId, minutes],
	);
}

test('Activity opens on the Log tab, with only that tab selected', async () => {
	let slug = '';
	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
		},
	});

	await router.navigate({ to: '/projects/$projectId/activity', params: { projectId: slug } });

	await findByText(/Every task, agent run, document, file and connector change/);
	const log = await findByTestId('activity-tab-log');
	const hours = await findByTestId('activity-tab-hours');
	// The active tab merges into the panel below it (`bg-bg`); an inactive one
	// stays recessed (`bg-surface-2`). The log is the index route, so a fuzzy
	// match would claim `/hours` too - both tabs reading as selected is the bug
	// this asserts against.
	expect(log.className).toContain('bg-bg');
	expect(hours.className).toContain('bg-surface-2');
	expect(hours.className).not.toContain('bg-bg');
});

test('the Hours tab reports each agent’s wall-clock time and the roster total', async () => {
	let slug = '';
	let engineerTitle = '';

	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[1];
			engineerTitle = engineer.human_name || engineer.title;
			// 45m for the engineer, 20m for the captain: the engineer leads, so it
			// must be both the first table row and the "busiest" tile.
			await seedRun(ws.team.id, engineer.id, 30);
			await seedRun(ws.team.id, engineer.id, 15);
			await seedRun(ws.team.id, captain.id, 20);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/activity/hours',
		params: { projectId: slug },
	});

	const table = await findByTestId('agent-hours-table');
	await waitFor(() => expect(table.textContent).toContain('45m'));
	expect(table.textContent).toContain('20m');
	// 45m + 20m, summed in the footer.
	expect(table.textContent).toContain('1h 5m');

	// The busiest tile names the agent that spent the most this month.
	const tiles = await findByTestId('agent-hours-tiles');
	expect(tiles.textContent).toContain(engineerTitle);

	// And the chart mounted with real cells rather than the empty state.
	await findByTestId('agent-hours-chart');
	expect(await findByText('Hours per day by agent')).toBeTruthy();
});

test('switching the bucket size refetches and retitles the chart', async () => {
	let slug = '';
	const { findByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			await seedRun(ws.team.id, engineer.id, 30);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/activity/hours',
		params: { projectId: slug },
	});

	await findByText('Hours per day by agent');
	const control = await findByTestId('hours-bucket');
	const month = [...control.querySelectorAll('button')].find((b) => b.textContent === 'Month');
	expect(month).toBeTruthy();
	if (month) await user.click(month);

	await findByText('Hours per month by agent');
	expect(month?.getAttribute('aria-pressed')).toBe('true');
});

test('the Hours tab says so plainly when nothing has run yet', async () => {
	let slug = '';
	const { findAllByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/activity/hours',
		params: { projectId: slug },
	});

	// Both the chart and the table fall back to the same sentence, so a project
	// with no history reads as empty rather than broken.
	const empties = await findAllByText('No finished runs yet.');
	expect(empties.length).toBe(2);
	// And the summary tiles stay off the page entirely rather than rendering a
	// row of zeroes and a busiest-agent tile with nobody in it.
	expect(document.querySelector('[data-testid="agent-hours-tiles"]')).toBeNull();
});
