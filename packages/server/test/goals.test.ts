import type { PGlite } from '@electric-sql/pglite';
import { GoalHealth } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import {
	createGoal,
	type GoalError,
	getDueGoals,
	listGoalRunActivity,
	listGoals,
	listProgressUpdateRuns,
	recordGoalProgress,
} from '../src/services/goals';
import { getProjectProgress, updateProjectProgress } from '../src/services/projects';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let captainMemberId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Goals Co', template_id: teamTemplateId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Goals Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);
	captainMemberId = captain.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

function jsonHeaders() {
	return { ...authHeader(token), 'content-type': 'application/json' };
}

describe('goals REST CRUD', () => {
	let goalId: string;

	it('creates a goal', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/goals`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				title: 'Reach 100 paying customers',
				measurement: '100 active paid subscriptions in Stripe',
				actions: 'Check the signup funnel weekly',
				check_frequency: 'weekly',
				target_date: '2026-09-30',
			}),
		});
		expect(res.status).toBe(201);
		const goal = (await res.json()).data;
		goalId = goal.id;
		expect(goal.title).toBe('Reach 100 paying customers');
		expect(goal.measurement).toBe('100 active paid subscriptions in Stripe');
		expect(goal.actions).toBe('Check the signup funnel weekly');
		expect(goal.check_frequency).toBe('weekly');
		expect(goal.health).toBe('pending');
		expect(goal.progress_percent).toBe(0);
	});

	it('lists goals with embedded (empty) history', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/goals`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const goals = (await res.json()).data;
		expect(goals).toHaveLength(1);
		expect(goals[0].history).toEqual([]);
		expect(goals[0].project_slug).toBe(projectSlug);
	});

	it('fetches a single goal', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/goals/${goalId}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.id).toBe(goalId);
	});

	it('patches a goal', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/goals/${goalId}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({ check_frequency: 'monthly', title: 'Reach 200 paying customers' }),
		});
		expect(res.status).toBe(200);
		const goal = (await res.json()).data;
		expect(goal.check_frequency).toBe('monthly');
		expect(goal.title).toBe('Reach 200 paying customers');
	});

	it('exposes the active goal count on the project detail payload', async () => {
		const res = await app.request(`/api/projects/${projectSlug}`, { headers: authHeader(token) });
		expect(res.status).toBe(200);
		expect((await res.json()).data.open_goal_count).toBe(1);
	});

	it('exposes the active goal count on the project index (drives the sidebar dot)', async () => {
		const res = await app.request('/api/projects', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const project = (await res.json()).data.find((p: { slug: string }) => p.slug === projectSlug);
		expect(project.open_goal_count).toBe(1);
	});

	it('archives a goal and hides it from the default list', async () => {
		const del = await app.request(`/api/projects/${projectSlug}/goals/${goalId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);
		expect((await del.json()).data.archived_at).not.toBeNull();

		// Archiving drops it out of the active count.
		const proj = await app.request(`/api/projects/${projectSlug}`, { headers: authHeader(token) });
		expect((await proj.json()).data.open_goal_count).toBe(0);

		const active = await app.request(`/api/projects/${projectSlug}/goals`, {
			headers: authHeader(token),
		});
		expect((await active.json()).data).toHaveLength(0);

		const all = await app.request(`/api/projects/${projectSlug}/goals?include_archived=true`, {
			headers: authHeader(token),
		});
		expect((await all.json()).data).toHaveLength(1);
	});
});

describe('goals service', () => {
	it('rejects goal creation on the internal HQ project', async () => {
		const hq = await db.query<{ id: string; team_id: string }>(
			`SELECT id, team_id FROM projects WHERE is_internal = true LIMIT 1`,
		);
		await expect(
			createGoal(
				db,
				hq.rows[0].team_id,
				{ project_id: hq.rows[0].id, title: 'No goals here' },
				{ actorMemberId: null },
				undefined,
			),
		).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<GoalError>);
	});

	it('selects only due goals based on frequency and last_checked_at', async () => {
		// daily goal never checked -> due; daily goal checked 2h ago -> not due;
		// daily goal checked 2 days ago -> due; weekly checked 2 days ago -> not due.
		const mk = async (title: string, freq: string, checkedAgo: string | null): Promise<string> => {
			const r = await db.query<{ id: string }>(
				`INSERT INTO goals (team_id, project_id, title, check_frequency, last_checked_at)
				 VALUES ($1, $2, $3, $4::goal_check_frequency, ${checkedAgo ? `now() - interval '${checkedAgo}'` : 'NULL'})
				 RETURNING id`,
				[teamId, projectId, title, freq],
			);
			return r.rows[0].id;
		};
		const neverChecked = await mk('daily-never', 'daily', null);
		const checkedRecently = await mk('daily-2h', 'daily', '2 hours');
		const checkedStale = await mk('daily-2d', 'daily', '2 days');
		const weeklyRecent = await mk('weekly-2d', 'weekly', '2 days');

		const due = await getDueGoals(db, projectId);
		const dueIds = new Set(due.map((g) => g.id));
		expect(dueIds.has(neverChecked)).toBe(true);
		expect(dueIds.has(checkedStale)).toBe(true);
		expect(dueIds.has(checkedRecently)).toBe(false);
		expect(dueIds.has(weeklyRecent)).toBe(false);
	});

	it('checks a goal whose deadline is due even when its frequency is not', async () => {
		// A goal is never skipped once its deadline (target_date) has arrived, regardless of
		// cadence. A goal whose deadline is still in the future falls back to the frequency test.
		const mk = async (title: string, checkedAgo: string, targetDate: string): Promise<string> => {
			const r = await db.query<{ id: string }>(
				`INSERT INTO goals (team_id, project_id, title, check_frequency, last_checked_at, target_date)
				 VALUES ($1, $2, $3, 'weekly'::goal_check_frequency, now() - interval '${checkedAgo}', ${targetDate})
				 RETURNING id`,
				[teamId, projectId, title],
			);
			return r.rows[0].id;
		};
		// Checked an hour ago (frequency NOT due), but deadline passed yesterday -> due.
		const deadlinePassed = await mk('deadline-passed', '1 hour', `now() - interval '1 day'`);
		// Checked an hour ago (frequency NOT due), deadline a week out -> skipped.
		const deadlineFuture = await mk('deadline-future', '1 hour', `now() + interval '7 days'`);

		const due = await getDueGoals(db, projectId);
		const dueIds = new Set(due.map((g) => g.id));
		expect(dueIds.has(deadlinePassed)).toBe(true);
		expect(dueIds.has(deadlineFuture)).toBe(false);
	});

	it('records progress: updates the goal, advances last_checked_at, writes history and run summary', async () => {
		const goal = await db.query<{ id: string }>(
			`INSERT INTO goals (team_id, project_id, title) VALUES ($1, $2, 'Track me') RETURNING id`,
			[teamId, projectId],
		);
		const goalRowId = goal.rows[0].id;
		// A Captain progress-update run with no task.
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, kind)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, 'progress_update'::heartbeat_run_kind)
			 RETURNING id`,
			[teamId, captainMemberId],
		);
		const runId = run.rows[0].id;

		const updated = await recordGoalProgress(
			db,
			{
				goalId: goalRowId,
				runId,
				progressPercent: 35,
				health: GoalHealth.AtRisk,
				statusBlurb: 'Behind on hiring',
			},
			undefined,
		);
		expect(updated.progress_percent).toBe(35);
		expect(updated.health).toBe('at_risk');
		expect(updated.last_checked_at).not.toBeNull();

		// History is embedded in the list payload.
		const goals = await listGoals(db, projectId);
		const tracked = goals.find((g) => g.id === goalRowId);
		expect(tracked?.history).toHaveLength(1);
		expect(tracked?.history[0].percent).toBe(35);

		// The progress-update run shows up annotated with the goal title.
		const runs = await listProgressUpdateRuns(db, projectId);
		const summary = runs.find((r) => r.id === runId);
		expect(summary).toBeTruthy();
		expect(summary?.updated_goal_titles).toContain('Track me');
		// The run carries its Captain so the UI can link to the run in the agent's run list.
		expect(summary?.member_id).toBe(captainMemberId);
		expect(summary?.agent_slug).toBe('captain');
	});

	it('rejects a pending health on recordGoalProgress', async () => {
		const goal = await db.query<{ id: string }>(
			`INSERT INTO goals (team_id, project_id, title) VALUES ($1, $2, 'Pending check') RETURNING id`,
			[teamId, projectId],
		);
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, kind)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, 'progress_update'::heartbeat_run_kind)
			 RETURNING id`,
			[teamId, captainMemberId],
		);
		await expect(
			recordGoalProgress(
				db,
				{
					goalId: goal.rows[0].id,
					runId: run.rows[0].id,
					progressPercent: 50,
					health: GoalHealth.Pending,
					statusBlurb: '',
				},
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});
});

describe('listGoalRunActivity', () => {
	let taskSeq = 5000;

	async function newProgressUpdateRun(): Promise<string> {
		const r = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, kind)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, 'progress_update'::heartbeat_run_kind)
			 RETURNING id`,
			[teamId, captainMemberId],
		);
		return r.rows[0].id;
	}

	async function newGoal(title: string): Promise<string> {
		const r = await db.query<{ id: string }>(
			`INSERT INTO goals (team_id, project_id, title) VALUES ($1, $2, $3) RETURNING id`,
			[teamId, projectId, title],
		);
		return r.rows[0].id;
	}

	async function newTask(opts: {
		goalId?: string | null;
		runId?: string | null;
	}): Promise<{ id: string; identifier: string }> {
		const n = ++taskSeq;
		const r = await db.query<{ id: string; identifier: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels, goal_id, created_by_run_id)
			 VALUES ($1, $2, $3, $4, 'Seed task', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb, $5, $6)
			 RETURNING id, identifier`,
			[teamId, projectId, n, `GP-${n}`, opts.goalId ?? null, opts.runId ?? null],
		);
		return r.rows[0];
	}

	async function comment(taskId: string, runId: string): Promise<void> {
		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_by_run_id)
			 VALUES ($1, $2, 'text'::comment_content_type, '{"text":"nudge"}'::jsonb, $3)`,
			[taskId, captainMemberId, runId],
		);
	}

	it('returns progress-update runs that estimated, created tasks for, or commented on the goal', async () => {
		const goalA = await newGoal('Feed goal A');
		const goalB = await newGoal('Feed goal B');

		// Run A: estimates goalA, creates one task for it, and comments on another goalA task.
		const runA = await newProgressUpdateRun();
		await recordGoalProgress(
			db,
			{
				goalId: goalA,
				runId: runA,
				progressPercent: 30,
				health: GoalHealth.OnTrack,
				statusBlurb: 'Going well',
			},
			undefined,
		);
		const created = await newTask({ goalId: goalA, runId: runA });
		const commented = await newTask({ goalId: goalA });
		await comment(commented.id, runA);

		// Run B touches only goalB — must not surface for goalA.
		const runB = await newProgressUpdateRun();
		await recordGoalProgress(
			db,
			{
				goalId: goalB,
				runId: runB,
				progressPercent: 10,
				health: GoalHealth.AtRisk,
				statusBlurb: 'Slow',
			},
			undefined,
		);

		const activityA = await listGoalRunActivity(db, projectId, goalA);
		expect(activityA.map((r) => r.id)).toContain(runA);
		expect(activityA.map((r) => r.id)).not.toContain(runB);

		const a = activityA.find((r) => r.id === runA);
		expect(a?.progress?.progress_percent).toBe(30);
		expect(a?.progress?.health).toBe(GoalHealth.OnTrack);
		expect(a?.created_tasks.map((t) => t.identifier)).toContain(created.identifier);
		expect(a?.commented_tasks.map((t) => t.identifier)).toContain(commented.identifier);
		expect(a?.commented_tasks.find((t) => t.id === commented.id)?.comment_count).toBe(1);

		const activityB = await listGoalRunActivity(db, projectId, goalB);
		expect(activityB.map((r) => r.id)).toContain(runB);
		expect(activityB.map((r) => r.id)).not.toContain(runA);
	});

	it('includes a run that only created a task for the goal, with null progress', async () => {
		const goal = await newGoal('Feed goal C');
		const run = await newProgressUpdateRun();
		const created = await newTask({ goalId: goal, runId: run });

		const activity = await listGoalRunActivity(db, projectId, goal);
		const entry = activity.find((r) => r.id === run);
		expect(entry).toBeTruthy();
		expect(entry?.progress).toBeNull();
		expect(entry?.created_tasks.map((t) => t.identifier)).toContain(created.identifier);
	});
});

describe('project progress summary', () => {
	it('sets and reads the project progress summary (service + REST)', async () => {
		const updated = await updateProjectProgress(
			db,
			teamId,
			projectId,
			'**Shipping v1.** Auth done; payments in progress.',
			undefined,
		);
		expect(updated.summary).toContain('Shipping v1');
		expect(updated.updated_at).not.toBeNull();

		const got = await getProjectProgress(db, projectId);
		expect(got?.summary).toContain('Shipping v1');

		const res = await app.request(`/api/projects/${projectSlug}/progress`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.summary).toContain('Shipping v1');
	});

	it('rejects an unknown project', async () => {
		await expect(
			updateProjectProgress(db, teamId, crypto.randomUUID(), 'x', undefined),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});
