import { resetRuntimeConfig, setPolicy } from '@hezo/server/src/config/runtime';
import { HQ_PROJECT_SLUG, SandboxBackend } from '@hezo/shared';
import { fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

/**
 * A project's hours budget on its Hours tab: daily, weekly and monthly limits on
 * its container hours, set by the instance owner alone, beneath the instance
 * allowance HQ's Hours tab shows.
 *
 * The card renders where an hour costs something or a limit is already set, so
 * the cases that need it on an unlimited project pin a remote backend.
 */

const HOUR = 3600;

afterEach(() => {
	resetRuntimeConfig();
});

/** Bill this project's containers on a remote backend, as a hosted instance does. */
function pinRemoteBackend(pinned: Record<string, number | SandboxBackend> = {}): void {
	setPolicy({ managedBy: 'Acme Cloud', pinned: { ...pinned, backend: SandboxBackend.Daytona } });
}

async function setLimits(
	projectId: string,
	daily: number,
	weekly: number,
	monthly: number,
): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`UPDATE projects SET daily_budget_container_seconds = $2,
		        weekly_budget_container_seconds = $3, monthly_budget_container_seconds = $4
		  WHERE id = $1`,
		[projectId, daily, weekly, monthly],
	);
}

test('the instance owner sets a limit, and the weekly one is raised to cover the daily', async () => {
	let slug = '';
	let projectId = '';
	const { findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			pinRemoteBackend();
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Hours Owner' });
			slug = project.slug;
			projectId = project.id;
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget/hours', params: { projectId: slug } });

	const daily = await findByTestId('hours-budget-window-daily');
	expect(daily.textContent).toContain('No limit');

	await user.click(await findByTestId('edit-hours-budget'));
	await user.click(await findByTestId('hours-budget-daily-toggle'));
	const dailyInput = await findByTestId('hours-budget-daily');
	await user.clear(dailyInput);
	await user.type(dailyInput, '1');
	await user.click(await findByTestId('hours-budget-weekly-toggle'));
	const weeklyInput = await findByTestId('hours-budget-weekly');
	await user.clear(weeklyInput);
	await user.type(weeklyInput, '2');
	fireEvent.blur(weeklyInput);
	// One hour a day implies seven a week, so two is raised as it leaves the field.
	expect((weeklyInput as HTMLInputElement).value).toBe('7');

	await user.click(await findByTestId('save-hours-budget'));

	// The card reads the limits back from the server once the save lands.
	await waitFor(async () =>
		expect((await findByTestId('hours-budget-window-weekly')).textContent).toContain('/ 7h'),
	);
	const stored = await getTestContext().db.query<{ daily: string; weekly: string }>(
		`SELECT daily_budget_container_seconds AS daily, weekly_budget_container_seconds AS weekly
		   FROM projects WHERE id = $1`,
		[projectId],
	);
	expect(Number(stored.rows[0].daily)).toBe(HOUR);
	expect(Number(stored.rows[0].weekly)).toBe(7 * HOUR);
});

test('anyone else sees the limits and who sets them, with no control to change them', async () => {
	let slug = '';
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Hours Member' });
			slug = project.slug;
			await setLimits(project.id, 2 * HOUR, 0, 0);
			await ctx.db.query('UPDATE users SET is_superuser = false');
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget/hours', params: { projectId: slug } });

	expect((await findByTestId('hours-budget-window-daily')).textContent).toContain('2h');
	expect((await findByTestId('hours-budget-owner-only')).textContent).toBe(
		'Only an instance owner can change these limits.',
	);
	expect(queryByTestId('edit-hours-budget')).toBeNull();
});

test('a local daemon with no limit set shows no hours budget at all', async () => {
	let slug = '';
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Hours Local' });
			slug = project.slug;
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget/hours', params: { projectId: slug } });

	await findByTestId('container-hours-tiles');
	expect(queryByTestId('hours-budget')).toBeNull();
});

test("HQ adds the projects' monthly limits up against the allowance", async () => {
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			pinRemoteBackend({ monthlyContainerHours: 30 });
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Hours Hungry' });
			await setLimits(project.id, 0, 0, 40 * HOUR);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/budget/hours',
		params: { projectId: HQ_PROJECT_SLUG },
	});

	const note = await findByTestId('container-hours-project-limits');
	expect(note.textContent).toBe(
		'1 project has a monthly hours limit, of 40 h. That is more than the 30 h allowance. A limit sets no hours aside, so the allowance can run out before every project reaches its limit.',
	);
});

test('a project out of hours says so at the top of every page, and points at its Hours tab', async () => {
	let slug = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Hours Spent' });
			slug = project.slug;
			await setLimits(project.id, 1, 0, 0);
			await ctx.db.query(
				`INSERT INTO container_uptime_entries (project_id, container_id, started_at, ended_at, backend)
				 VALUES ($1, 'ctr-spent', GREATEST(now() - interval '5 minutes',
				         date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), now(), 'docker')`,
				[project.id],
			);
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget/team', params: { projectId: slug } });

	expect((await findByTestId('budget-banner-message')).textContent).toBe(
		'Project is over its hours budget - agent runs are paused',
	);
	expect((await findByTestId('budget-banner')).getAttribute('href')).toBe(
		`/projects/${slug}/budget/hours`,
	);
});
