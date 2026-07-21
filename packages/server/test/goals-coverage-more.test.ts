/**
 * Coverage-focused goals tests: exercises the goals service (create/update/list/
 * due-selection/progress-recording/run activity) and every REST route branch —
 * validation errors, HQ rejection, run-now dispatch reasons, and the queued-run
 * cancel lifecycle.
 */
import { GoalHealth } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAdminJwt } from '../src/middleware/auth';
import {
	countGoalRunActivity,
	countProgressUpdateRuns,
	createGoal,
	getDueGoals,
	getGoal,
	getGoalHistory,
	listGoalRunActivity,
	listGoals,
	listProgressUpdateRuns,
	recordGoalProgress,
	updateGoal,
} from '../src/services/goals';
import { authHeader, createTestProject, createTestTeam } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

let ctx: ServerTestContext;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let captainId: string;
let hqProjectSlug: string;

beforeAll(async () => {
	ctx = await createTestContext();
	token = ctx.token;
	const { app, db } = ctx;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const templateId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Goal Cov Co', template_id: templateId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Goal Cov Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);
	captainId = captain.rows[0].id;

	const hq = await db.query<{ slug: string }>(
		`SELECT slug FROM projects WHERE is_internal = true LIMIT 1`,
	);
	hqProjectSlug = hq.rows[0].slug;
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

function jsonHeaders() {
	return { ...authHeader(token), 'content-type': 'application/json' };
}

async function newProgressUpdateRun(): Promise<string> {
	const r = await ctx.db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (team_id, member_id, status, kind)
		 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, 'progress_update'::heartbeat_run_kind)
		 RETURNING id`,
		[teamId, captainId],
	);
	return r.rows[0].id;
}

describe('goals service — createGoal validation', () => {
	it('rejects a missing title and a missing project_id', async () => {
		await expect(
			createGoal(
				ctx.db,
				teamId,
				{ project_id: projectId, title: '   ' },
				{ actorMemberId: null },
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(
			createGoal(
				ctx.db,
				teamId,
				{ project_id: '', title: 'x' },
				{ actorMemberId: null },
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('rejects an invalid check_frequency', async () => {
		await expect(
			createGoal(
				ctx.db,
				teamId,
				{ project_id: projectId, title: 'Bad freq', check_frequency: 'hourly' },
				{ actorMemberId: null },
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('rejects an unknown project with NOT_FOUND', async () => {
		await expect(
			createGoal(
				ctx.db,
				teamId,
				{ project_id: crypto.randomUUID(), title: 'Nowhere' },
				{ actorMemberId: null },
				undefined,
			),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('defaults check_frequency to daily and trims the title', async () => {
		const goal = await createGoal(
			ctx.db,
			teamId,
			{ project_id: projectId, title: '  Trim me  ' },
			{ actorMemberId: null },
			undefined,
		);
		expect(goal.title).toBe('Trim me');
		expect(goal.check_frequency).toBe('daily');
	});
});

describe('goals REST routes', () => {
	let goalId: string;

	it('POST creates a goal (201)', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				title: 'Ship the coverage suite',
				measurement: 'All lines green',
				actions: 'Write tests',
				check_frequency: 'weekly',
				target_date: '2026-12-31',
			}),
		});
		expect(res.status).toBe(201);
		const goal = (await res.json()).data;
		goalId = goal.id;
		expect(goal.check_frequency).toBe('weekly');
		expect(goal.progress_percent).toBe(0);
	});

	it('POST with an invalid frequency is a 400 with a GoalError code', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ title: 'Bad', check_frequency: 'hourly' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('POST on the global HQ project is a 403 (FORBIDDEN maps via statusForGoalError)', async () => {
		const res = await ctx.app.request(`/api/projects/${hqProjectSlug}/goals`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({ title: 'No HQ goals' }),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe('FORBIDDEN');
	});

	it('GET lists goals; include_archived toggles archived rows', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const goals = (await res.json()).data;
		expect(goals.map((g: { id: string }) => g.id)).toContain(goalId);
		expect(goals[0].project_slug).toBe(projectSlug);
	});

	it('GET a single goal (200) and an unknown goal (404)', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/${goalId}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.id).toBe(goalId);

		const missing = await ctx.app.request(
			`/api/projects/${projectSlug}/goals/${crypto.randomUUID()}`,
			{ headers: authHeader(token) },
		);
		expect(missing.status).toBe(404);
	});

	it('PATCH updates every updatable field', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/${goalId}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({
				title: 'Ship it renamed',
				measurement: 'New measurement',
				actions: 'New actions',
				check_frequency: 'monthly',
				target_date: null,
			}),
		});
		expect(res.status).toBe(200);
		const goal = (await res.json()).data;
		expect(goal.title).toBe('Ship it renamed');
		expect(goal.measurement).toBe('New measurement');
		expect(goal.actions).toBe('New actions');
		expect(goal.check_frequency).toBe('monthly');
		expect(goal.target_date).toBeNull();
	});

	it('PATCH with no updatable fields is a 400', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/${goalId}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: '{}',
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('PATCH with an empty title is a 400', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/${goalId}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({ title: '   ' }),
		});
		expect(res.status).toBe(400);
	});

	it('PATCH an unknown goal is a 404', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/${crypto.randomUUID()}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({ title: 'x' }),
		});
		expect(res.status).toBe(404);
	});

	it('PATCH can archive and un-archive via the archived flag', async () => {
		const archived = await ctx.app.request(`/api/projects/${projectSlug}/goals/${goalId}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({ archived: true }),
		});
		expect(archived.status).toBe(200);
		expect((await archived.json()).data.archived_at).not.toBeNull();

		const restored = await ctx.app.request(`/api/projects/${projectSlug}/goals/${goalId}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({ archived: false }),
		});
		expect(restored.status).toBe(200);
		expect((await restored.json()).data.archived_at).toBeNull();
	});

	it('DELETE archives (soft-deletes); unknown goal is a 404', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/${goalId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.archived_at).not.toBeNull();

		const active = await ctx.app.request(`/api/projects/${projectSlug}/goals`, {
			headers: authHeader(token),
		});
		expect((await active.json()).data.map((g: { id: string }) => g.id)).not.toContain(goalId);
		const all = await ctx.app.request(`/api/projects/${projectSlug}/goals?include_archived=true`, {
			headers: authHeader(token),
		});
		expect((await all.json()).data.map((g: { id: string }) => g.id)).toContain(goalId);

		const missing = await ctx.app.request(
			`/api/projects/${projectSlug}/goals/${crypto.randomUUID()}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(missing.status).toBe(404);
	});

	it('updateGoal throws NOT_FOUND when the goal vanished between check and update', async () => {
		// The route pre-checks existence; the service-level NOT_FOUND covers the race.
		await expect(
			updateGoal(ctx.db, teamId, crypto.randomUUID(), { title: 'ghost' }, undefined),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});

describe('goal history and run activity routes', () => {
	let goalId: string;
	let runId: string;

	beforeAll(async () => {
		const goal = await createGoal(
			ctx.db,
			teamId,
			{ project_id: projectId, title: 'History goal' },
			{ actorMemberId: null },
			undefined,
		);
		goalId = goal.id;
		runId = await newProgressUpdateRun();
		await recordGoalProgress(
			ctx.db,
			{ goalId, runId, progressPercent: 42, health: GoalHealth.OnTrack, statusBlurb: 'Fine' },
			undefined,
		);
	});

	it('GET /history returns the full progress series; unknown goal is a 404', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/${goalId}/history`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const history = (await res.json()).data;
		expect(history).toHaveLength(1);
		expect(history[0].percent).toBe(42);
		expect(history[0].health).toBe('on_track');

		const missing = await ctx.app.request(
			`/api/projects/${projectSlug}/goals/${crypto.randomUUID()}/history`,
			{ headers: authHeader(token) },
		);
		expect(missing.status).toBe(404);
	});

	it('GET /goals/runs lists the progress-update runs with updated goal titles', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/runs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const runs = (await res.json()).data;
		const summary = runs.find((r: { id: string }) => r.id === runId);
		expect(summary).toBeTruthy();
		expect(summary.updated_goal_titles).toContain('History goal');
		expect(summary.agent_slug).toBe('captain');
	});

	it('GET /goals/:goalId/runs returns run activity; unknown goal is a 404', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/${goalId}/runs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const activity = (await res.json()).data;
		const entry = activity.find((r: { id: string }) => r.id === runId);
		expect(entry.progress.progress_percent).toBe(42);

		const missing = await ctx.app.request(
			`/api/projects/${projectSlug}/goals/${crypto.randomUUID()}/runs`,
			{ headers: authHeader(token) },
		);
		expect(missing.status).toBe(404);
	});

	it('getGoal / getGoalHistory return null for goals outside the project', async () => {
		expect(await getGoal(ctx.db, crypto.randomUUID(), goalId)).toBeNull();
		expect(await getGoalHistory(ctx.db, crypto.randomUUID(), goalId)).toBeNull();
	});

	it('GET /goals/runs paginates with offset + total meta', async () => {
		// Ensure at least three project-wide progress-update runs exist.
		await newProgressUpdateRun();
		await newProgressUpdateRun();

		const runsUrl = `/api/projects/${projectSlug}/goals/runs`;
		const all = await ctx.app.request(`${runsUrl}?per_page=200`, { headers: authHeader(token) });
		const allBody = await all.json();
		const total = allBody.meta.total as number;
		expect(total).toBeGreaterThanOrEqual(3);
		expect(allBody.data).toHaveLength(total);

		const p1 = await ctx.app.request(`${runsUrl}?page=1&per_page=2`, {
			headers: authHeader(token),
		});
		const b1 = await p1.json();
		expect(b1.meta).toEqual({ page: 1, per_page: 2, total });
		expect(b1.data).toHaveLength(2);

		const p2 = await ctx.app.request(`${runsUrl}?page=2&per_page=2`, {
			headers: authHeader(token),
		});
		const b2 = await p2.json();
		expect(b2.meta.page).toBe(2);
		// Adjacent pages never overlap.
		const ids1 = b1.data.map((r: { id: string }) => r.id);
		const ids2 = b2.data.map((r: { id: string }) => r.id);
		expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
	});

	it('GET /goals/:goalId/runs paginates with offset + total meta', async () => {
		// Add two more runs that touch this goal so it has >1 activity row.
		for (let i = 0; i < 2; i++) {
			const r = await newProgressUpdateRun();
			await recordGoalProgress(
				ctx.db,
				{ goalId, runId: r, progressPercent: 50 + i, health: GoalHealth.OnTrack, statusBlurb: 'x' },
				undefined,
			);
		}

		const url = `/api/projects/${projectSlug}/goals/${goalId}/runs`;
		const all = await ctx.app.request(`${url}?per_page=200`, { headers: authHeader(token) });
		const total = (await all.json()).meta.total as number;
		expect(total).toBeGreaterThanOrEqual(3);

		const p1 = await ctx.app.request(`${url}?page=1&per_page=2`, { headers: authHeader(token) });
		const b1 = await p1.json();
		expect(b1.meta).toEqual({ page: 1, per_page: 2, total });
		expect(b1.data).toHaveLength(2);
	});
});

describe('getDueGoals cadence branches', () => {
	async function mkGoal(opts: {
		title: string;
		freq: string;
		checkedAgo?: string | null;
		targetDate?: string | null;
		percent?: number;
	}): Promise<string> {
		const r = await ctx.db.query<{ id: string }>(
			`INSERT INTO goals (team_id, project_id, title, check_frequency, last_checked_at, target_date, progress_percent)
			 VALUES ($1, $2, $3, $4::goal_check_frequency,
			         ${opts.checkedAgo ? `now() - interval '${opts.checkedAgo}'` : 'NULL'},
			         ${opts.targetDate ?? 'NULL'}, $5)
			 RETURNING id`,
			[teamId, projectId, opts.title, opts.freq, opts.percent ?? 0],
		);
		return r.rows[0].id;
	}

	it('selects on cadence for daily, weekly, and monthly frequencies', async () => {
		const dailyDue = await mkGoal({ title: 'd-due', freq: 'daily', checkedAgo: '30 hours' });
		const dailyFresh = await mkGoal({ title: 'd-fresh', freq: 'daily', checkedAgo: '2 hours' });
		const weeklyDue = await mkGoal({ title: 'w-due', freq: 'weekly', checkedAgo: '8 days' });
		const weeklyFresh = await mkGoal({ title: 'w-fresh', freq: 'weekly', checkedAgo: '2 days' });
		const monthlyDue = await mkGoal({ title: 'm-due', freq: 'monthly', checkedAgo: '35 days' });
		const monthlyFresh = await mkGoal({ title: 'm-fresh', freq: 'monthly', checkedAgo: '5 days' });
		const neverChecked = await mkGoal({ title: 'never', freq: 'monthly' });

		const due = new Set((await getDueGoals(ctx.db, projectId)).map((g) => g.id));
		expect(due.has(dailyDue)).toBe(true);
		expect(due.has(dailyFresh)).toBe(false);
		expect(due.has(weeklyDue)).toBe(true);
		expect(due.has(weeklyFresh)).toBe(false);
		expect(due.has(monthlyDue)).toBe(true);
		expect(due.has(monthlyFresh)).toBe(false);
		expect(due.has(neverChecked)).toBe(true);
	});

	it('applies the past-deadline override only while progress is below 100', async () => {
		const overdue = await mkGoal({
			title: 'deadline-unmet',
			freq: 'weekly',
			checkedAgo: '1 hour',
			targetDate: `now() - interval '1 day'`,
			percent: 50,
		});
		const met = await mkGoal({
			title: 'deadline-met',
			freq: 'weekly',
			checkedAgo: '1 hour',
			targetDate: `now() - interval '1 day'`,
			percent: 100,
		});
		const archived = await mkGoal({
			title: 'deadline-archived',
			freq: 'weekly',
			checkedAgo: '1 hour',
			targetDate: `now() - interval '1 day'`,
			percent: 10,
		});
		await ctx.db.query(`UPDATE goals SET archived_at = now() WHERE id = $1`, [archived]);

		const due = new Set((await getDueGoals(ctx.db, projectId)).map((g) => g.id));
		expect(due.has(overdue)).toBe(true);
		expect(due.has(met)).toBe(false);
		expect(due.has(archived)).toBe(false);
	});
});

describe('recordGoalProgress', () => {
	let goalId: string;

	beforeAll(async () => {
		const goal = await createGoal(
			ctx.db,
			teamId,
			{ project_id: projectId, title: 'Record me' },
			{ actorMemberId: null },
			undefined,
		);
		goalId = goal.id;
	});

	it('rejects out-of-range and non-finite percentages', async () => {
		const runId = await newProgressUpdateRun();
		for (const pct of [-5, 150, Number.NaN]) {
			await expect(
				recordGoalProgress(
					ctx.db,
					{ goalId, runId, progressPercent: pct, health: GoalHealth.OnTrack, statusBlurb: '' },
					undefined,
				),
			).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		}
	});

	it('rejects a pending health', async () => {
		const runId = await newProgressUpdateRun();
		await expect(
			recordGoalProgress(
				ctx.db,
				{ goalId, runId, progressPercent: 10, health: GoalHealth.Pending, statusBlurb: '' },
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('throws NOT_FOUND for an unknown goal', async () => {
		const runId = await newProgressUpdateRun();
		await expect(
			recordGoalProgress(
				ctx.db,
				{
					goalId: crypto.randomUUID(),
					runId,
					progressPercent: 10,
					health: GoalHealth.OnTrack,
					statusBlurb: '',
				},
				undefined,
			),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('rounds, updates the goal, and upserts the per-run history row on re-record', async () => {
		const runId = await newProgressUpdateRun();
		const first = await recordGoalProgress(
			ctx.db,
			{
				goalId,
				runId,
				progressPercent: 33.4,
				health: GoalHealth.AtRisk,
				statusBlurb: 'first pass',
			},
			undefined,
		);
		expect(first.progress_percent).toBe(33);
		expect(first.health).toBe('at_risk');
		expect(first.last_checked_at).not.toBeNull();

		// Same (run, goal) again — the ON CONFLICT DO UPDATE path replaces the snapshot.
		const second = await recordGoalProgress(
			ctx.db,
			{
				goalId,
				runId,
				progressPercent: 66,
				health: GoalHealth.OnTrack,
				statusBlurb: 'revised',
			},
			undefined,
		);
		expect(second.progress_percent).toBe(66);

		const history = await getGoalHistory(ctx.db, projectId, goalId);
		expect(history).toHaveLength(1);
		expect(history?.[0].percent).toBe(66);

		// The list payload embeds the same history.
		const goals = await listGoals(ctx.db, projectId, { includeArchived: true });
		const mine = goals.find((g) => g.id === goalId);
		expect(mine?.history).toHaveLength(1);
		expect(mine?.history[0].percent).toBe(66);
	});
});

describe('listProgressUpdateRuns / listGoalRunActivity', () => {
	let taskSeq = 8100;

	async function newTask(opts: { goalId?: string | null; runId?: string | null }) {
		const n = ++taskSeq;
		const r = await ctx.db.query<{ id: string; identifier: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels, goal_id, created_by_run_id)
			 VALUES ($1, $2, $3, $4, 'Cov task', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb, $5, $6)
			 RETURNING id, identifier`,
			[teamId, projectId, n, `GCV-${n}`, opts.goalId ?? null, opts.runId ?? null],
		);
		return r.rows[0];
	}

	it('annotates runs with goal titles and honours the limit', async () => {
		const goal = await createGoal(
			ctx.db,
			teamId,
			{ project_id: projectId, title: 'Annotated goal' },
			{ actorMemberId: null },
			undefined,
		);
		const runId = await newProgressUpdateRun();
		await recordGoalProgress(
			ctx.db,
			{
				goalId: goal.id,
				runId,
				progressPercent: 20,
				health: GoalHealth.OffTrack,
				statusBlurb: 'slow',
			},
			undefined,
		);

		const runs = await listProgressUpdateRuns(ctx.db, projectId);
		const summary = runs.find((r) => r.id === runId);
		expect(summary?.updated_goal_titles).toContain('Annotated goal');
		expect(summary?.member_id).toBe(captainId);

		const limited = await listProgressUpdateRuns(ctx.db, projectId, { limit: 1 });
		expect(limited).toHaveLength(1);
	});

	it('countProgressUpdateRuns matches the list and offset skips rows', async () => {
		const total = await countProgressUpdateRuns(ctx.db, projectId);
		const all = await listProgressUpdateRuns(ctx.db, projectId, { limit: total });
		expect(all).toHaveLength(total);
		expect(total).toBeGreaterThanOrEqual(2);

		const firstTwo = await listProgressUpdateRuns(ctx.db, projectId, { limit: 2, offset: 0 });
		const afterOne = await listProgressUpdateRuns(ctx.db, projectId, { limit: 2, offset: 1 });
		// offset 1 drops the newest row and shares the second with the offset-0 page.
		expect(firstTwo[1].id).toBe(afterOne[0].id);
		expect(firstTwo[0].id).not.toBe(afterOne[0].id);
	});

	it('countGoalRunActivity matches the per-goal list and offset skips rows', async () => {
		const goal = await createGoal(
			ctx.db,
			teamId,
			{ project_id: projectId, title: 'Counted goal' },
			{ actorMemberId: null },
			undefined,
		);
		for (let i = 0; i < 3; i++) {
			const runId = await newProgressUpdateRun();
			await recordGoalProgress(
				ctx.db,
				{
					goalId: goal.id,
					runId,
					progressPercent: 10 * i,
					health: GoalHealth.OnTrack,
					statusBlurb: 's',
				},
				undefined,
			);
		}
		const total = await countGoalRunActivity(ctx.db, projectId, goal.id);
		expect(total).toBe(3);
		const paged = await listGoalRunActivity(ctx.db, projectId, goal.id, { limit: 2, offset: 2 });
		expect(paged).toHaveLength(1);
	});

	it('collects estimate, created-task, and commented-task activity per goal', async () => {
		const goalA = await createGoal(
			ctx.db,
			teamId,
			{ project_id: projectId, title: 'Activity A' },
			{ actorMemberId: null },
			undefined,
		);
		const goalB = await createGoal(
			ctx.db,
			teamId,
			{ project_id: projectId, title: 'Activity B' },
			{ actorMemberId: null },
			undefined,
		);

		const runA = await newProgressUpdateRun();
		await recordGoalProgress(
			ctx.db,
			{
				goalId: goalA.id,
				runId: runA,
				progressPercent: 55,
				health: GoalHealth.OnTrack,
				statusBlurb: 'ok',
			},
			undefined,
		);
		const created = await newTask({ goalId: goalA.id, runId: runA });
		const commented = await newTask({ goalId: goalA.id });
		await ctx.db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_by_run_id)
			 VALUES ($1, $2, 'text'::comment_content_type, '{"text":"ping"}'::jsonb, $3)`,
			[commented.id, captainId, runA],
		);

		// A run that only created a task for goalB — surfaces with null progress.
		const runB = await newProgressUpdateRun();
		const createdB = await newTask({ goalId: goalB.id, runId: runB });

		const activityA = await listGoalRunActivity(ctx.db, projectId, goalA.id);
		const a = activityA.find((r) => r.id === runA);
		expect(a?.progress?.progress_percent).toBe(55);
		expect(a?.created_tasks.map((t) => t.identifier)).toContain(created.identifier);
		expect(a?.commented_tasks.map((t) => t.identifier)).toContain(commented.identifier);
		expect(a?.commented_tasks.find((t) => t.id === commented.id)?.comment_count).toBe(1);
		expect(activityA.map((r) => r.id)).not.toContain(runB);

		const activityB = await listGoalRunActivity(ctx.db, projectId, goalB.id);
		const b = activityB.find((r) => r.id === runB);
		expect(b?.progress).toBeNull();
		expect(b?.created_tasks.map((t) => t.identifier)).toContain(createdB.identifier);
		expect(activityB.map((r) => r.id)).not.toContain(runA);

		const limited = await listGoalRunActivity(ctx.db, projectId, goalA.id, { limit: 1 });
		expect(limited).toHaveLength(1);
	});
});

describe('run-now dispatch and queued-run lifecycle', () => {
	it('is a 404 when the team has no Captain', async () => {
		await ctx.db.query(
			`UPDATE member_agents SET slug = 'captain-hidden'
			 WHERE id = $1`,
			[captainId],
		);
		try {
			const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/run-now`, {
				method: 'POST',
				headers: jsonHeaders(),
				body: '{}',
			});
			expect(res.status).toBe(404);
			expect((await res.json()).error.code).toBe('NOT_FOUND');
		} finally {
			await ctx.db.query(`UPDATE member_agents SET slug = 'captain' WHERE id = $1`, [captainId]);
		}
	});

	it('is a 409 when the Captain is disabled', async () => {
		await ctx.db.query(
			`UPDATE member_agents SET admin_status = 'disabled'::agent_admin_status WHERE id = $1`,
			[captainId],
		);
		try {
			const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/run-now`, {
				method: 'POST',
				headers: jsonHeaders(),
				body: '{}',
			});
			expect(res.status).toBe(409);
			expect((await res.json()).error.code).toBe('CONFLICT');
		} finally {
			await ctx.db.query(
				`UPDATE member_agents SET admin_status = 'enabled'::agent_admin_status WHERE id = $1`,
				[captainId],
			);
		}
	});

	it('queues when a goal is due but the container is down, then supports cancel', async () => {
		// The project's due goals already exist from the cadence tests, so run-now
		// passes the "nothing due" gate and hits the container-down conflict → queued.
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/run-now`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: '{}',
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		expect(body.queued).toBe(true);
		const wakeupId = body.wakeup_id as string;
		expect(wakeupId).toBeTruthy();

		// The queued run surfaces on the project-scoped queued-run endpoint.
		const queued = await ctx.app.request(`/api/projects/${projectSlug}/goals/queued-run`, {
			headers: authHeader(token),
		});
		expect(queued.status).toBe(200);
		const queuedBody = (await queued.json()).data;
		expect(queuedBody.queued.id).toBe(wakeupId);

		// Cancelling an unknown wakeup id is a 404 (no existence leak).
		const unknown = await ctx.app.request(
			`/api/projects/${projectSlug}/goals/queued-run/${crypto.randomUUID()}/cancel`,
			{ method: 'POST', headers: jsonHeaders(), body: '{}' },
		);
		expect(unknown.status).toBe(404);

		// Cancel the real one.
		const cancel = await ctx.app.request(
			`/api/projects/${projectSlug}/goals/queued-run/${wakeupId}/cancel`,
			{ method: 'POST', headers: jsonHeaders(), body: '{}' },
		);
		expect(cancel.status).toBe(200);
		expect((await cancel.json()).data.cancelled).toBe(true);

		const after = await ctx.app.request(`/api/projects/${projectSlug}/goals/queued-run`, {
			headers: authHeader(token),
		});
		expect((await after.json()).data.queued).toBeNull();

		// Cancelling again is a 409 — the wakeup is no longer queued.
		const again = await ctx.app.request(
			`/api/projects/${projectSlug}/goals/queued-run/${wakeupId}/cancel`,
			{ method: 'POST', headers: jsonHeaders(), body: '{}' },
		);
		expect(again.status).toBe(409);
	});

	it('reports no_due_goals as a valid 200 no-op once nothing is due', async () => {
		// Mark every active goal as freshly checked with future/absent deadlines.
		await ctx.db.query(
			`UPDATE goals SET last_checked_at = now(), target_date = NULL WHERE project_id = $1`,
			[projectId],
		);
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/run-now`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: '{}',
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		expect(body.dispatched).toBe(false);
		expect(body.reason).toBe('no_due_goals');
	});

	it('accepts run-now from a superuser with no member row in the team (null triggered_by)', async () => {
		// A superuser spans all teams but may have no members row in this one, so
		// resolveActorMemberId returns null and triggered_by stays null.
		const user = await ctx.db.query<{ id: string }>(
			`INSERT INTO users (display_name, is_superuser) VALUES ('Outside Admin', true) RETURNING id`,
		);
		const outsiderToken = await signAdminJwt(ctx.masterKeyManager, user.rows[0].id);
		const res = await ctx.app.request(`/api/projects/${projectSlug}/goals/run-now`, {
			method: 'POST',
			headers: { ...authHeader(outsiderToken), 'content-type': 'application/json' },
			body: '{}',
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		expect(body.dispatched).toBe(false);
		expect(body.reason).toBe('no_due_goals');
	});
});
