import type { PGlite } from '@electric-sql/pglite';
import { GoalHealth } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import {
	createGoal,
	type GoalError,
	getDueGoals,
	listGoalCheckRuns,
	listGoals,
	recordGoalProgress,
} from '../src/services/goals';
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

	it('records progress: updates the goal, advances last_checked_at, writes history and run summary', async () => {
		const goal = await db.query<{ id: string }>(
			`INSERT INTO goals (team_id, project_id, title) VALUES ($1, $2, 'Track me') RETURNING id`,
			[teamId, projectId],
		);
		const goalRowId = goal.rows[0].id;
		// A Captain goal-check run with no task.
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, kind)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, 'goal_check'::heartbeat_run_kind)
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

		// The goal-check run shows up annotated with the goal title.
		const runs = await listGoalCheckRuns(db, projectId);
		const summary = runs.find((r) => r.id === runId);
		expect(summary).toBeTruthy();
		expect(summary?.updated_goal_titles).toContain('Track me');
	});

	it('rejects a pending health on recordGoalProgress', async () => {
		const goal = await db.query<{ id: string }>(
			`INSERT INTO goals (team_id, project_id, title) VALUES ($1, $2, 'Pending check') RETURNING id`,
			[teamId, projectId],
		);
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, kind)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, 'goal_check'::heartbeat_run_kind)
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
