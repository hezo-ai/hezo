import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { wakeIfReady } from '../src/lib/dependencies';
import { assignmentWakeupAlreadyServed } from '../src/services/wakeup';
import { safeClose } from './helpers';
import { createTestApp, createTestProject, createTestTeam } from './helpers/app';

// The wakeIfReady failure path: a createWakeup error is logged and swallowed —
// an unblock that can't enqueue a wakeup must never propagate into the caller
// (the status-change / dependency-mutation request that triggered it).

let db: Db;
let teamId: string;
let taskId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	const teamRes = await createTestTeam(db, { name: 'Unblock Err Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Unblock Err Project' });
	const projectId = (await projectRes.json()).data.id;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);

	const num = await db.query<{ number: number }>('SELECT next_project_task_number($1) AS number', [
		projectId,
	]);
	const task = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title, assignee_id)
		 VALUES ($1, $2, $3, $4, 'Unblocked task', $5) RETURNING id`,
		[teamId, projectId, num.rows[0].number, `UE-${num.rows[0].number}`, captain.rows[0].id],
	);
	taskId = task.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('wakeIfReady', () => {
	it('swallows a createWakeup failure instead of failing the unblock (expected [error] log)', async () => {
		// Delegate everything to the real db, but fail createWakeup's first query
		// (the idempotency-key lookup) — wakeIfReady's own reads stay live.
		const failing: Db = Object.create(db);
		failing.query = ((sql: string, params?: unknown[]) => {
			if (sql.includes('idempotency_key')) {
				return Promise.reject(new Error('injected wakeup insert failure'));
			}
			return db.query(sql, params);
		}) as Db['query'];

		await expect(wakeIfReady(failing, taskId)).resolves.toBeUndefined();

		// No wakeup row landed for the assignee.
		const wakeups = await db.query(
			`SELECT 1 FROM agent_wakeup_requests WHERE payload->>'task_id' = $1`,
			[taskId],
		);
		expect(wakeups.rows).toHaveLength(0);
	});

	it('enqueues the unblock wakeup when nothing fails (control)', async () => {
		await wakeIfReady(db, taskId);
		const wakeups = await db.query<{ payload: { reason: string } }>(
			`SELECT payload FROM agent_wakeup_requests WHERE payload->>'task_id' = $1`,
			[taskId],
		);
		expect(wakeups.rows).toHaveLength(1);
		expect(wakeups.rows[0].payload.reason).toBe('unblocked');
	});

	it('re-stamps a released blocker-deferral so a pre-release run cannot retire it', async () => {
		// The stranded shape: a wakeup parked while the task was blocked, and a run
		// that touched the task during that window (a mention reply, say) and
		// succeeded. On release, the dispatcher's already-served check measures
		// staleness from the wakeup's creation - so unless the release re-stamps
		// the row, that mid-block run reads as having served it and the released
		// wake is retired without ever waking the assignee.
		const task = await db.query<{ id: string; assignee_id: string; team_id: string }>(
			`SELECT id, assignee_id, team_id FROM tasks WHERE id = $1`,
			[taskId],
		);
		const { assignee_id: memberId, team_id: teamIdRow } = task.rows[0];

		const num = await db.query<{ number: number }>(
			`SELECT next_project_task_number(project_id) AS number FROM tasks WHERE id = $1`,
			[taskId],
		);
		const stale = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, assignee_id)
			 SELECT team_id, project_id, $2, $3, 'Released task', assignee_id FROM tasks WHERE id = $1
			 RETURNING id`,
			[taskId, num.rows[0].number, `UE-${num.rows[0].number}`],
		);
		const staleTaskId = stale.rows[0].id;

		await db.query(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, created_at)
			 VALUES ($1, $2, 'assignment', 'deferred'::wakeup_status, $3::jsonb, now() - interval '20 minutes')`,
			[memberId, teamIdRow, JSON.stringify({ task_id: staleTaskId, reason: 'blocked' })],
		);
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status,
			         now() - interval '10 minutes', now() - interval '9 minutes')`,
			[teamIdRow, memberId, staleTaskId],
		);

		await wakeIfReady(db, staleTaskId);

		const released = await db.query<{ status: string; created_at: string }>(
			`SELECT status, created_at FROM agent_wakeup_requests WHERE payload->>'task_id' = $1`,
			[staleTaskId],
		);
		expect(released.rows).toHaveLength(1);
		expect(released.rows[0].status).toBe('queued');
		// The re-stamp is what keeps the pre-release run from reading as service.
		expect(
			await assignmentWakeupAlreadyServed(db, memberId, staleTaskId, released.rows[0].created_at),
		).toBe(false);
	});
});
