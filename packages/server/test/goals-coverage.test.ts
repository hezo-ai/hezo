import type { PGlite } from '@electric-sql/pglite';
import { GoalHealth } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import {
	createGoal,
	type GoalError,
	getGoal,
	getGoalHistory,
	recordGoalProgress,
	updateGoal,
} from '../src/services/goals';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let teamId: string;
let projectId: string;
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
	const teamRes = await createTestTeam(db, { name: 'Goals Cov Co', template_id: teamTemplateId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Goals Cov Project' });
	projectId = (await projectRes.json()).data.id;

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

async function newGoal(title = 'A goal'): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO goals (team_id, project_id, title) VALUES ($1, $2, $3) RETURNING id`,
		[teamId, projectId, title],
	);
	return r.rows[0].id;
}

async function newGoalCheckRun(): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (team_id, member_id, status, kind)
		 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, 'goal_check'::heartbeat_run_kind)
		 RETURNING id`,
		[teamId, captainMemberId],
	);
	return r.rows[0].id;
}

describe('createGoal validation', () => {
	it('rejects a missing project_id', async () => {
		await expect(
			createGoal(db, teamId, { project_id: '', title: 'x' }, { actorMemberId: null }, undefined),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' } satisfies Partial<GoalError>);
	});

	it('rejects a blank title (whitespace only)', async () => {
		await expect(
			createGoal(
				db,
				teamId,
				{ project_id: projectId, title: '   ' },
				{ actorMemberId: null },
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('rejects an invalid check_frequency', async () => {
		await expect(
			createGoal(
				db,
				teamId,
				{ project_id: projectId, title: 'Cadence', check_frequency: 'hourly' },
				{ actorMemberId: null },
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('returns NOT_FOUND when the project is not in the team', async () => {
		await expect(
			createGoal(
				db,
				teamId,
				{ project_id: crypto.randomUUID(), title: 'Orphan' },
				{ actorMemberId: null },
				undefined,
			),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('defaults the frequency to daily and applies optional defaults', async () => {
		const goal = await createGoal(
			db,
			teamId,
			{ project_id: projectId, title: '  Trim Me  ' },
			{ actorMemberId: captainMemberId },
			undefined,
		);
		expect(goal.title).toBe('Trim Me');
		expect(goal.check_frequency).toBe('daily');
		expect(goal.measurement).toBe('');
		expect(goal.actions).toBe('');
	});
});

describe('updateGoal validation and field branches', () => {
	it('rejects an update with no fields', async () => {
		const id = await newGoal();
		await expect(updateGoal(db, teamId, id, {}, undefined)).rejects.toMatchObject({
			code: 'INVALID_REQUEST',
		});
	});

	it('rejects clearing the title to empty', async () => {
		const id = await newGoal();
		await expect(updateGoal(db, teamId, id, { title: '   ' }, undefined)).rejects.toMatchObject({
			code: 'INVALID_REQUEST',
		});
	});

	it('rejects an invalid check_frequency on update', async () => {
		const id = await newGoal();
		await expect(
			updateGoal(db, teamId, id, { check_frequency: 'yearly' }, undefined),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('returns NOT_FOUND for an unknown goal', async () => {
		await expect(
			updateGoal(db, teamId, crypto.randomUUID(), { title: 'Nope' }, undefined),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('updates every settable field including measurement, actions and target_date', async () => {
		const id = await newGoal('Before');
		const updated = await updateGoal(
			db,
			teamId,
			id,
			{
				title: 'After',
				measurement: 'New metric',
				actions: 'New actions',
				check_frequency: 'weekly',
				target_date: '2027-01-01',
			},
			undefined,
		);
		expect(updated.title).toBe('After');
		expect(updated.measurement).toBe('New metric');
		expect(updated.actions).toBe('New actions');
		expect(updated.check_frequency).toBe('weekly');
		expect(new Date(updated.target_date as string).toISOString()).toContain('2027-01-01');
	});

	it('archives then un-archives via the archived flag', async () => {
		const id = await newGoal('Toggle');
		const archived = await updateGoal(db, teamId, id, { archived: true }, undefined);
		expect(archived.archived_at).not.toBeNull();
		const unarchived = await updateGoal(db, teamId, id, { archived: false }, undefined);
		expect(unarchived.archived_at).toBeNull();
	});

	it('does not update a goal belonging to another team', async () => {
		const id = await newGoal('Team-scoped');
		await expect(
			updateGoal(db, crypto.randomUUID(), id, { title: 'Hijack' }, undefined),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});

describe('recordGoalProgress validation', () => {
	it('rejects progress above 100', async () => {
		const id = await newGoal();
		const runId = await newGoalCheckRun();
		await expect(
			recordGoalProgress(
				db,
				{
					goalId: id,
					runId,
					progressPercent: 150,
					health: GoalHealth.OnTrack,
					statusBlurb: '',
				},
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('rejects negative progress', async () => {
		const id = await newGoal();
		const runId = await newGoalCheckRun();
		await expect(
			recordGoalProgress(
				db,
				{
					goalId: id,
					runId,
					progressPercent: -5,
					health: GoalHealth.OnTrack,
					statusBlurb: '',
				},
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('returns NOT_FOUND when the goal does not exist', async () => {
		const runId = await newGoalCheckRun();
		await expect(
			recordGoalProgress(
				db,
				{
					goalId: crypto.randomUUID(),
					runId,
					progressPercent: 50,
					health: GoalHealth.OnTrack,
					statusBlurb: 'x',
				},
				undefined,
			),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('rounds a fractional percent before storing', async () => {
		const id = await newGoal('Rounding');
		const runId = await newGoalCheckRun();
		const updated = await recordGoalProgress(
			db,
			{
				goalId: id,
				runId,
				progressPercent: 42.6,
				health: GoalHealth.AtRisk,
				statusBlurb: 'rounded',
			},
			undefined,
		);
		expect(updated.progress_percent).toBe(43);
	});

	it('upserts the run/goal history row on a repeated record for the same run', async () => {
		const id = await newGoal('Upsert');
		const runId = await newGoalCheckRun();
		await recordGoalProgress(
			db,
			{ goalId: id, runId, progressPercent: 10, health: GoalHealth.OnTrack, statusBlurb: 'first' },
			undefined,
		);
		await recordGoalProgress(
			db,
			{ goalId: id, runId, progressPercent: 20, health: GoalHealth.AtRisk, statusBlurb: 'second' },
			undefined,
		);
		const rows = await db.query<{ progress_percent: number; status_blurb: string }>(
			`SELECT progress_percent, status_blurb FROM goal_run_updates WHERE run_id = $1 AND goal_id = $2`,
			[runId, id],
		);
		expect(rows.rows.length).toBe(1);
		expect(rows.rows[0].progress_percent).toBe(20);
		expect(rows.rows[0].status_blurb).toBe('second');
	});
});

describe('getGoal / getGoalHistory missing-row branches', () => {
	it('getGoal returns null for an unknown goal', async () => {
		expect(await getGoal(db, projectId, crypto.randomUUID())).toBeNull();
	});

	it('getGoalHistory returns null when the goal does not exist', async () => {
		expect(await getGoalHistory(db, projectId, crypto.randomUUID())).toBeNull();
	});

	it('getGoalHistory returns the recorded series for an existing goal', async () => {
		const id = await newGoal('History');
		const runId = await newGoalCheckRun();
		await recordGoalProgress(
			db,
			{ goalId: id, runId, progressPercent: 25, health: GoalHealth.OnTrack, statusBlurb: 'go' },
			undefined,
		);
		const history = await getGoalHistory(db, projectId, id);
		expect(history).not.toBeNull();
		expect(history?.length).toBe(1);
		expect(history?.[0].percent).toBe(25);
	});

	it('getGoalHistory returns an empty array for a goal with no updates', async () => {
		const id = await newGoal('Empty History');
		const history = await getGoalHistory(db, projectId, id);
		expect(history).toEqual([]);
	});
});
