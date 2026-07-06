import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { wakeIfReady } from '../src/lib/dependencies';
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
});
