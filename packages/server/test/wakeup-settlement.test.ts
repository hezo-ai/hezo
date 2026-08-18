import { WakeupSkipReason, WakeupSource, WakeupStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { settleWakeupForRun } from '../src/services/wakeup';
import { safeClose } from './helpers';
import { createTestApp, createTestTeam } from './helpers/app';

/**
 * The seam that answers "what happens to the work this run was woken for?".
 * It had no direct test at all, which is how its `claimed` guard came to exist
 * on one caller and not the other, and how `handback_failed` came to be a signal
 * nothing acted on.
 */
let db: Db;
let teamId: string;
let memberId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	const team = await createTestTeam(db, { name: 'Settlement Co' });
	teamId = (await team.json()).data.id;
	const member = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'agent', 'Settler') RETURNING id`,
		[teamId],
	);
	memberId = member.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

async function seedWakeup(status: WakeupStatus): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, claimed_at)
		 VALUES ($1, $2, $3::wakeup_source, $4::wakeup_status, now())
		 RETURNING id`,
		[memberId, teamId, WakeupSource.Mention, status],
	);
	return r.rows[0].id;
}

async function readWakeup(id: string) {
	const r = await db.query<{
		status: string;
		claimed_at: string | null;
		last_skipped_reason: string | null;
	}>('SELECT status, claimed_at, last_skipped_reason FROM agent_wakeup_requests WHERE id = $1', [
		id,
	]);
	return r.rows[0];
}

describe('settleWakeupForRun', () => {
	it('hands a claimed wakeup back to the queue, labelled with the wait that gave up', async () => {
		const id = await seedWakeup(WakeupStatus.Claimed);
		const settled = await settleWakeupForRun(db, id, {
			kind: 'handback',
			reason: WakeupSkipReason.CredentialBusy,
		});

		expect(settled).toEqual({ kind: 'requeued' });
		const row = await readWakeup(id);
		expect(row.status).toBe(WakeupStatus.Queued);
		expect(row.claimed_at).toBeNull();
		// The label decides what the task sidebar tells an operator, and whether the
		// idle pass counts the project busy. Both waits reached here stamping
		// `instance_at_capacity` regardless of which one had actually given up.
		expect(row.last_skipped_reason).toBe(WakeupSkipReason.CredentialBusy);
	});

	it('refuses to resurrect a wakeup another path already settled, and says so', async () => {
		// The guard is the load-bearing part: returning a completed wakeup to the
		// queue dispatches its work a second time. Reporting the refusal is equally
		// load-bearing - a caller that reads this as success leaves work owed while
		// its run row claims the work was queued.
		const id = await seedWakeup(WakeupStatus.Completed);
		const settled = await settleWakeupForRun(db, id, {
			kind: 'handback',
			reason: WakeupSkipReason.RunNeverStarted,
		});

		expect(settled).toEqual({ kind: 'handback_failed' });
		expect((await readWakeup(id)).status).toBe(WakeupStatus.Completed);
	});

	it('settles every terminal intent to its own status', async () => {
		for (const [intent, expected] of [
			['complete', WakeupStatus.Completed],
			['fail', WakeupStatus.Failed],
			['withdraw', WakeupStatus.Cancelled],
		] as const) {
			const id = await seedWakeup(WakeupStatus.Claimed);
			const settled = await settleWakeupForRun(db, id, { kind: intent });
			expect(settled).toEqual({ kind: 'terminal', status: expected });
			expect((await readWakeup(id)).status).toBe(expected);
		}
	});

	it('leaves a terminal wakeup alone, so the first decision stands', async () => {
		// The mirror of the handback guard. A person presses Terminate, which settles
		// the wakeup `cancelled` immediately; the aborting run reaches
		// `onAgentComplete` seconds later with `fail` and would relabel work somebody
		// deliberately withdrew as work that failed. Whoever settled first knew more.
		const id = await seedWakeup(WakeupStatus.Claimed);
		await settleWakeupForRun(db, id, { kind: 'withdraw' });

		const second = await settleWakeupForRun(db, id, { kind: 'fail' });

		expect(second).toEqual({ kind: 'terminal', status: WakeupStatus.Cancelled });
		expect((await readWakeup(id)).status).toBe(WakeupStatus.Cancelled);
	});

	it('reports when there was no wakeup to settle rather than pretending it worked', async () => {
		// A synthetic or manual run has none, and a caller must be able to tell that
		// apart from a successful handback.
		expect(await settleWakeupForRun(db, undefined, { kind: 'complete' })).toEqual({
			kind: 'nothing_to_settle',
		});
		expect(await settleWakeupForRun(db, null, { kind: 'fail' })).toEqual({
			kind: 'nothing_to_settle',
		});
	});
});
