import type { PGlite } from '@electric-sql/pglite';
import { HeartbeatRunKind, WakeupSource } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHeartbeatRun, type HeartbeatRunBroadcast } from '../src/services/agent-runner';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let db: PGlite;
let teamId: string;
let captainMemberId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	const token = ctx.token;

	const typesRes = await ctx.app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Goal Check Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	await createTestProject(db, teamId, { name: 'Goal Check Project' });

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

describe('createHeartbeatRun for goal-check (null task)', () => {
	it('creates a kind=goal_check run with no task and no Run comment', async () => {
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
			 VALUES ($1, $2, $3::wakeup_source, 'claimed'::wakeup_status, '{}'::jsonb)
			 RETURNING id`,
			[captainMemberId, teamId, WakeupSource.Heartbeat],
		);
		const broadcast: HeartbeatRunBroadcast = {
			teamId,
			taskId: null,
			memberId: captainMemberId,
		};

		const commentsBefore = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM task_comments`,
		);

		const runId = await createHeartbeatRun(
			db,
			{ id: captainMemberId, title: 'Captain', team_id: teamId },
			teamId,
			null,
			broadcast,
			wakeup.rows[0].id,
			null,
			HeartbeatRunKind.GoalCheck,
		);

		const run = await db.query<{ task_id: string | null; kind: string }>(
			`SELECT task_id, kind::text AS kind FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		expect(run.rows[0].task_id).toBeNull();
		expect(run.rows[0].kind).toBe('goal_check');

		// No task comment was written (a goal-check run has no task to anchor one).
		const commentsAfter = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM task_comments`,
		);
		expect(commentsAfter.rows[0].c).toBe(commentsBefore.rows[0].c);
	});
});
