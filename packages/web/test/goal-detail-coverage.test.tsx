import { type GoalRunActivity, HeartbeatRunStatus } from '@hezo/shared';
import { api } from '@hezo/web/lib/api';
import { within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededGoal, seedGoal, seedProject, seedWorkspace } from './helpers/seed';

// Component tier (happy-dom). Covers the GoalDetailPage branches goals.test.tsx
// doesn't reach: the not-found state, the archived badge + unarchive action, and
// the populated run feed (status badge for a non-succeeded run, progress line,
// created/commented task chips). The runs endpoint is stubbed via the api.get
// spy so we control the activity rows deterministically.

afterEach(() => {
	vi.restoreAllMocks();
});

test('renders the not-found state for a missing goal', async () => {
	let projectSlug = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Goal NF Project' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals/$goalId',
		params: { projectId: projectSlug, goalId: 'does-not-exist' },
	});

	const nf = await findByTestId('goal-not-found', undefined, { timeout: 15_000 });
	expect(nf.textContent).toContain('Goal not found');
});

test('an archived goal shows the Archived badge and an unarchive control', async () => {
	let projectSlug = '';
	let goalId = '';
	const { findByText, findByRole, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Goal Arch Project' });
			projectSlug = project.slug;
			const goal = await seedGoal(ws, project, {
				title: 'Archived goal',
				measurement: 'done',
			});
			goalId = goal.id;
			// Archive it directly so the detail page renders the archived branch.
			await getTestContext().db.query(`UPDATE goals SET archived_at = now() WHERE id = $1`, [
				goal.id,
			]);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals/$goalId',
		params: { projectId: projectSlug, goalId },
	});

	await findByRole('heading', { name: 'Archived goal' }, { timeout: 15_000 });
	await findByText('Archived');
	// The action button toggles to "Unarchive goal" when the goal is archived.
	const archiveBtn = await findByTestId('goal-archive');
	expect(archiveBtn.getAttribute('aria-label')).toBe('Unarchive goal');
});

test('the run feed renders status badge, progress line, and created/commented task chips', async () => {
	let projectSlug = '';
	let goal: SeededGoal = { id: '', title: '' };
	const { findByTestId, findAllByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Goal Runs Project' });
			projectSlug = project.slug;
			goal = await seedGoal(ws, project, { title: 'Goal with runs', measurement: 'measure' });
		},
	});

	const runs: GoalRunActivity[] = [
		{
			id: 'run-1',
			status: HeartbeatRunStatus.Failed,
			created_at: '2026-05-20T11:30:00Z',
			started_at: '2026-05-20T11:30:00Z',
			finished_at: '2026-05-20T11:31:00Z',
			progress: { progress_percent: 42, health: 'on_track', status_blurb: 'Halfway there.' },
			created_tasks: [
				{ id: 'tt1', identifier: 'OPS-10', title: 'Created task', status: 'backlog' },
			],
			commented_tasks: [
				{
					id: 'tt2',
					identifier: 'OPS-11',
					title: 'Commented task',
					status: 'backlog',
					comment_count: 3,
				},
			],
		},
	];

	const realGet = api.get.bind(api);
	vi.spyOn(api, 'get').mockImplementation(((
		path: string,
		params?: Record<string, string | undefined>,
	) => {
		if (path.endsWith(`/goals/${goal.id}/runs`)) return Promise.resolve(runs);
		return realGet(path, params);
	}) as typeof api.get);

	await router.navigate({
		to: '/projects/$projectId/goals/$goalId',
		params: { projectId: projectSlug, goalId: goal.id },
	});

	const runRows = await findAllByTestId('goal-run', undefined, { timeout: 15_000 });
	expect(runRows.length).toBe(1);
	const row = runRows[0];
	// Non-succeeded run → status badge shows the status.
	expect(row.textContent).toContain('failed');
	// Progress line: "42% · on_track" and the status blurb.
	expect(row.textContent).toContain('42%');
	expect(row.textContent).toContain('on_track');
	expect(row.textContent).toContain('Halfway there.');
	// Created and commented task chips, the latter showing its comment count.
	expect(row.textContent).toContain('Created');
	expect(row.textContent).toContain('OPS-10');
	expect(row.textContent).toContain('Commented on');
	expect(row.textContent).toContain('OPS-11');
	expect(row.textContent).toContain('(3)');

	// The created-task chip is a real link to the task page.
	const links = within(row).getAllByRole('link');
	const createdLink = links.find((a) => /OPS-10/.test(a.textContent ?? ''));
	expect(createdLink?.getAttribute('href')).toContain('/tasks/ops-10');

	// Sanity: the feed section mounted (not the empty branch).
	await findByTestId('goal-runs');
});
