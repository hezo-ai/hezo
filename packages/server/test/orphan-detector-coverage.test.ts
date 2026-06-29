import type { PGlite } from '@electric-sql/pglite';
import { HeartbeatRunStatus, WakeupSource, WakeupStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	detectOrphans,
	healStaleRunState,
	STALE_STATE_GRACE_SECONDS,
} from '../src/services/orphan-detector';
import { safeClose } from './helpers';
import { createTestApp, createTestTeam } from './helpers/app';

let db: PGlite;
let teamId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	const teamRes = await createTestTeam(db, { name: 'Orphan Cov Co' });
	teamId = (await teamRes.json()).data.id;
	const agent = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
		[teamId],
	);
	agentId = agent.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('detectOrphans — safety window', () => {
	it('does not orphan a running row that started inside the safety window', async () => {
		await db.query(
			`DELETE FROM heartbeat_runs WHERE team_id = $1 AND status = $2::heartbeat_run_status`,
			[teamId, HeartbeatRunStatus.Running],
		);
		// started just now → started_at is well within SAFETY_WINDOW_SECONDS, so the
		// WHERE clause excludes it and it is not counted/marked failed.
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, started_at)
			 VALUES ($1, $2, $3::heartbeat_run_status, now())
			 RETURNING id`,
			[teamId, agentId, HeartbeatRunStatus.Running],
		);

		const count = await detectOrphans(db, new Set());
		expect(count).toBe(0);

		const after = await db.query<{ status: string }>(
			`SELECT status FROM heartbeat_runs WHERE id = $1`,
			[run.rows[0].id],
		);
		expect(after.rows[0].status).toBe(HeartbeatRunStatus.Running);

		await db.query(`DELETE FROM heartbeat_runs WHERE id = $1`, [run.rows[0].id]);
	});
});

describe('healStaleRunState — no-op on a clean slate', () => {
	it('returns without error when there is nothing stranded', async () => {
		await db.query(`DELETE FROM heartbeat_runs WHERE team_id = $1`, [teamId]);
		await db.query(`DELETE FROM agent_wakeup_requests WHERE member_id = $1`, [agentId]);
		await expect(healStaleRunState(db)).resolves.toBeUndefined();
	});

	it('does not resolve a claimed wakeup still inside the grace window', async () => {
		await db.query(`DELETE FROM agent_wakeup_requests WHERE member_id = $1`, [agentId]);
		// claimed just now → inside STALE_STATE_GRACE_SECONDS → left untouched.
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, claimed_at, created_at)
			 VALUES ($1, $2, $3::wakeup_source, $4::wakeup_status, now(), now())
			 RETURNING id`,
			[agentId, teamId, WakeupSource.Assignment, WakeupStatus.Claimed],
		);

		expect(STALE_STATE_GRACE_SECONDS).toBeGreaterThan(0);
		await healStaleRunState(db);

		const after = await db.query<{ status: string }>(
			`SELECT status FROM agent_wakeup_requests WHERE id = $1`,
			[wakeup.rows[0].id],
		);
		expect(after.rows[0].status).toBe(WakeupStatus.Claimed);
		await db.query(`DELETE FROM agent_wakeup_requests WHERE id = $1`, [wakeup.rows[0].id]);
	});
});
