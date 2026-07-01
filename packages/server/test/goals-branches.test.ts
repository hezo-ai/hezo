import type { PGlite } from '@electric-sql/pglite';
import { GoalHealth } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/**
 * Branch coverage for services/goals.ts: the validation arms of createGoal /
 * updateGoal / recordGoalProgress and the not-found returns of getGoal /
 * getGoalHistory that the happy-path goals.test.ts doesn't reach. Pure service
 * calls — no REST layer, no docker, no GitHub.
 */

let db: PGlite;
let teamId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	// Goals need a non-internal project, which needs a Captain — so provision a
	// Startup-templated team rather than reusing HQ (CEO/Coach only, no Captain).
	const typesRes = await ctx.app.request('/api/team-templates', { headers: authHeader(ctx.token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;
	const team = (
		await (await createTestTeam(db, { name: 'Goal Branches Co', template_id: typeId })).json()
	).data;
	teamId = team.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Goal Branches Project' });
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('createGoal validation branches', () => {
	it('rejects a missing title (INVALID_REQUEST)', async () => {
		await expect(
			createGoal(
				db,
				teamId,
				{ project_id: projectId, title: '   ' },
				{ actorMemberId: null },
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' } satisfies Partial<GoalError>);
	});

	it('rejects a missing project_id (INVALID_REQUEST)', async () => {
		await expect(
			createGoal(
				db,
				teamId,
				{ project_id: '', title: 'A goal' },
				{ actorMemberId: null },
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('rejects an invalid check_frequency (assertFrequency throw)', async () => {
		await expect(
			createGoal(
				db,
				teamId,
				{ project_id: projectId, title: 'Bad freq', check_frequency: 'hourly' },
				{ actorMemberId: null },
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('404s when the project does not exist for this team', async () => {
		await expect(
			createGoal(
				db,
				teamId,
				{ project_id: crypto.randomUUID(), title: 'Orphan goal' },
				{ actorMemberId: null },
				undefined,
			),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('creates a goal with default frequency when none supplied', async () => {
		const goal = await createGoal(
			db,
			teamId,
			{ project_id: projectId, title: 'Default freq goal' },
			{ actorMemberId: null },
			undefined,
		);
		expect(goal.check_frequency).toBe('daily');
	});
});

describe('updateGoal branches', () => {
	let goalId: string;

	beforeAll(async () => {
		const goal = await createGoal(
			db,
			teamId,
			{ project_id: projectId, title: 'To update', measurement: 'm', actions: 'a' },
			{ actorMemberId: null },
			undefined,
		);
		goalId = goal.id;
	});

	it('rejects when no updatable fields are provided', async () => {
		await expect(updateGoal(db, teamId, goalId, {}, undefined)).rejects.toMatchObject({
			code: 'INVALID_REQUEST',
		});
	});

	it('rejects an empty title', async () => {
		await expect(updateGoal(db, teamId, goalId, { title: '   ' }, undefined)).rejects.toMatchObject(
			{ code: 'INVALID_REQUEST' },
		);
	});

	it('updates measurement, actions, and target_date together', async () => {
		const updated = await updateGoal(
			db,
			teamId,
			goalId,
			{ measurement: 'new measure', actions: 'new actions', target_date: '2027-01-01' },
			undefined,
		);
		expect(updated.measurement).toBe('new measure');
		expect(updated.actions).toBe('new actions');
	});

	it('archives (archived=true) then un-archives (archived=false)', async () => {
		const archived = await updateGoal(db, teamId, goalId, { archived: true }, undefined);
		expect(archived.archived_at).not.toBeNull();
		const unarchived = await updateGoal(db, teamId, goalId, { archived: false }, undefined);
		expect(unarchived.archived_at).toBeNull();
	});

	it('updates the title (non-empty) and check_frequency', async () => {
		const updated = await updateGoal(
			db,
			teamId,
			goalId,
			{ title: 'Renamed goal', check_frequency: 'weekly' },
			undefined,
		);
		expect(updated.title).toBe('Renamed goal');
		expect(updated.check_frequency).toBe('weekly');
	});

	it('404s when the goal does not exist', async () => {
		await expect(
			updateGoal(db, teamId, crypto.randomUUID(), { title: 'x' }, undefined),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});

describe('getGoal / getGoalHistory not-found branches', () => {
	it('getGoal returns null for an unknown goal', async () => {
		const goal = await getGoal(db, projectId, crypto.randomUUID());
		expect(goal).toBeNull();
	});

	it('getGoalHistory returns null when the goal does not exist', async () => {
		const history = await getGoalHistory(db, projectId, crypto.randomUUID());
		expect(history).toBeNull();
	});

	it('getGoalHistory returns the (empty) series for an existing goal', async () => {
		const goal = await createGoal(
			db,
			teamId,
			{ project_id: projectId, title: 'History goal' },
			{ actorMemberId: null },
			undefined,
		);
		const history = await getGoalHistory(db, projectId, goal.id);
		expect(history).toEqual([]);
	});
});

describe('recordGoalProgress validation branches', () => {
	let goalId: string;
	let runId: string;

	beforeAll(async () => {
		const goal = await createGoal(
			db,
			teamId,
			{ project_id: projectId, title: 'Progress goal' },
			{ actorMemberId: null },
			undefined,
		);
		goalId = goal.id;
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, kind)
			 VALUES ($1, (SELECT id FROM member_agents WHERE slug = 'ceo' LIMIT 1),
			         'succeeded'::heartbeat_run_status, 'progress_update'::heartbeat_run_kind)
			 RETURNING id`,
			[teamId],
		);
		runId = run.rows[0].id;
	});

	it('rejects a progress_percent above 100', async () => {
		await expect(
			recordGoalProgress(
				db,
				{ goalId, runId, progressPercent: 150, health: GoalHealth.OnTrack, statusBlurb: '' },
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('rejects a negative progress_percent', async () => {
		await expect(
			recordGoalProgress(
				db,
				{ goalId, runId, progressPercent: -5, health: GoalHealth.OnTrack, statusBlurb: '' },
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('rejects a non-finite progress_percent', async () => {
		await expect(
			recordGoalProgress(
				db,
				{ goalId, runId, progressPercent: Number.NaN, health: GoalHealth.OnTrack, statusBlurb: '' },
				undefined,
			),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('404s when the goal does not exist', async () => {
		await expect(
			recordGoalProgress(
				db,
				{
					goalId: crypto.randomUUID(),
					runId,
					progressPercent: 50,
					health: GoalHealth.OnTrack,
					statusBlurb: '',
				},
				undefined,
			),
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('rounds the percent and writes both the goal and the history row', async () => {
		const updated = await recordGoalProgress(
			db,
			{ goalId, runId, progressPercent: 42.6, health: GoalHealth.OnTrack, statusBlurb: 'ok' },
			undefined,
		);
		expect(updated.progress_percent).toBe(43);
	});
});
