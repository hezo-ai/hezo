// What the provider-refusal hold on a wakeup selects, against real rows.
//
// Kept apart from `job-manager-scheduling.test.ts`, which proves the fragment is
// wired into the wakeup scan with one case. The semantics need several, and
// asserting them through `processWakeups` would dispatch a real agent per case
// to observe a row that was *not* held.

import { WakeupSkipReason } from '@hezo/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import {
	releaseUsageHeldWakeups,
	settleWakeupForRun,
	WAKEUP_HOLD_ELAPSED_SQL,
} from '../src/services/wakeup';
import { safeClose } from './helpers';
import { createTestApp, createTestTeam } from './helpers/app';

let db: Db;
let teamId: string;
let memberId: string;

/**
 * Insert a wakeup, optionally skipped for `reason` and held until `holdMin`
 * minutes from now (negative for a hold already over).
 */
async function wakeup(
	opts: { reason?: string; holdMin?: number; status?: string } = {},
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests
		   (member_id, team_id, source, status, payload, last_skipped_reason, last_skipped_at, not_before)
		 VALUES ($1, $2, 'timer', $3::wakeup_status, '{}'::jsonb, $4,
		         CASE WHEN $4::text IS NULL THEN NULL ELSE now() END,
		         CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(mins => $5::int) END)
		 RETURNING id`,
		[memberId, teamId, opts.status ?? 'queued', opts.reason ?? null, opts.holdMin ?? null],
	);
	return r.rows[0].id;
}

/** The ids the scan would still consider, in the order it takes them. */
async function selectable(limit = 100): Promise<string[]> {
	const r = await db.query<{ id: string }>(
		`SELECT id FROM agent_wakeup_requests
		  WHERE team_id = $1 AND status = 'queued' AND ${WAKEUP_HOLD_ELAPSED_SQL}
		  ORDER BY created_at ASC LIMIT ${limit}`,
		[teamId],
	);
	return r.rows.map((x) => x.id);
}

async function notBefore(id: string): Promise<Date | null> {
	const r = await db.query<{ not_before: Date | null }>(
		'SELECT not_before FROM agent_wakeup_requests WHERE id = $1',
		[id],
	);
	return r.rows[0].not_before;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	const teamRes = await createTestTeam(db, { name: 'Cooldown Co' });
	teamId = (await teamRes.json()).data.id;
	const m = await db.query<{ id: string }>('SELECT id FROM members WHERE team_id = $1 LIMIT 1', [
		teamId,
	]);
	memberId = m.rows[0].id;
});

afterEach(async () => {
	await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);
});

afterAll(async () => {
	await safeClose(db);
});

describe('provider refusal hold on a wakeup', () => {
	it('keeps a wakeup that was never held', async () => {
		const id = await wakeup();
		const skipped = await wakeup({ reason: WakeupSkipReason.InstanceAtCapacity });
		expect(await selectable()).toEqual([id, skipped]);
	});

	it('holds a wakeup until its time, then releases it', async () => {
		const held = await wakeup({ reason: WakeupSkipReason.ProviderUsageLimit, holdMin: 60 });
		const over = await wakeup({ reason: WakeupSkipReason.ProviderAtCapacity, holdMin: -1 });
		expect(await selectable()).toEqual([over]);
		expect(await selectable()).not.toContain(held);
	});

	it('writes the hold on handback and clears it on a handback without one', async () => {
		const id = await wakeup({ status: 'claimed' });
		const until = new Date(Date.now() + 3 * 60 * 60_000);
		const settled = await settleWakeupForRun(db, id, {
			kind: 'handback',
			reason: WakeupSkipReason.ProviderUsageLimit,
			notBefore: until,
		});
		expect(settled.kind).toBe('requeued');
		expect((await notBefore(id))?.getTime()).toBe(until.getTime());
		expect(await selectable()).toEqual([]);

		// A later handback for a wait with no clock of its own must not inherit the
		// earlier hold, or capacity work would sit out a usage reset it has no part in.
		await db.query(`UPDATE agent_wakeup_requests SET status = 'claimed' WHERE id = $1`, [id]);
		await settleWakeupForRun(db, id, {
			kind: 'handback',
			reason: WakeupSkipReason.InstanceAtCapacity,
		});
		expect(await notBefore(id)).toBeNull();
		expect(await selectable()).toEqual([id]);
	});

	it('does not let held wakeups crowd a fresh one out of the scan window', async () => {
		// Why the filter is in the scan's WHERE rather than a `continue` in the
		// dispatch loop: the scan takes the ten OLDEST queued wakeups, so held rows
		// are by then old rows and would fill the window on every tick, starving
		// newer work for as long as the outage lasted.
		for (let i = 0; i < 10; i++) {
			await wakeup({ reason: WakeupSkipReason.ProviderUsageLimit, holdMin: 60 });
		}
		const fresh = await wakeup();
		expect(await selectable(10)).toEqual([fresh]);
	});

	it('releases only the wakeups held for a spent usage allowance', async () => {
		const usage = await wakeup({ reason: WakeupSkipReason.ProviderUsageLimit, holdMin: 60 });
		const capacity = await wakeup({ reason: WakeupSkipReason.ProviderAtCapacity, holdMin: 5 });

		expect(await releaseUsageHeldWakeups(db)).toBe(1);
		expect(await selectable()).toEqual([usage]);
		expect(await notBefore(capacity)).not.toBeNull();

		// Nothing left to release writes nothing.
		expect(await releaseUsageHeldWakeups(db)).toBe(0);
	});
});
