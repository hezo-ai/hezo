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
	USAGE_HOLD_RELEASE_SPACING_SEC,
	WAKEUP_HOLD_ELAPSED_SQL,
} from '../src/services/wakeup';
import { safeClose } from './helpers';
import { createTestApp, createTestTeam } from './helpers/app';

let db: Db;
let teamId: string;
let memberId: string;
let configA: string;
let configB: string;

/**
 * Insert a wakeup, optionally skipped for `reason` and held until `holdMin`
 * minutes from now (negative for a hold already over), on credential `heldOn`,
 * created `ageMin` minutes ago.
 */
async function wakeup(
	opts: {
		reason?: string;
		holdMin?: number;
		status?: string;
		heldOn?: string;
		ageMin?: number;
	} = {},
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests
		   (member_id, team_id, source, status, payload, last_skipped_reason, last_skipped_at,
		    not_before, held_config_id, created_at)
		 VALUES ($1, $2, 'timer', $3::wakeup_status, '{}'::jsonb, $4,
		         CASE WHEN $4::text IS NULL THEN NULL ELSE now() END,
		         CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(mins => $5::int) END,
		         $6, now() - make_interval(mins => $7::int))
		 RETURNING id`,
		[
			memberId,
			teamId,
			opts.status ?? 'queued',
			opts.reason ?? null,
			opts.holdMin ?? null,
			opts.heldOn ?? null,
			opts.ageMin ?? 0,
		],
	);
	return r.rows[0].id;
}

/** Seconds from now until the wakeup may be claimed, rounded. */
async function secondsUntil(id: string): Promise<number> {
	const r = await db.query<{ s: number }>(
		`SELECT round(EXTRACT(EPOCH FROM (not_before - now())))::int AS s
		   FROM agent_wakeup_requests WHERE id = $1`,
		[id],
	);
	return r.rows[0].s;
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
	const configs = await db.query<{ id: string; label: string }>(
		`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential)
		 VALUES ('openai', 'subscription', 'Cooldown A', 'x'), ('openai', 'subscription', 'Cooldown B', 'y')
		 RETURNING id, label`,
	);
	configA = configs.rows.find((c) => c.label === 'Cooldown A')?.id ?? '';
	configB = configs.rows.find((c) => c.label === 'Cooldown B')?.id ?? '';
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
			reason: WakeupSkipReason.ProviderAtCapacity,
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
		const usage = await wakeup({
			reason: WakeupSkipReason.ProviderUsageLimit,
			holdMin: 60,
			heldOn: configA,
		});
		const capacity = await wakeup({ reason: WakeupSkipReason.ProviderAtCapacity, holdMin: 5 });

		expect(await releaseUsageHeldWakeups(db, configA)).toBe(1);
		expect(await selectable()).toEqual([usage]);
		expect(await notBefore(capacity)).not.toBeNull();

		// Nothing left to release writes nothing.
		expect(await releaseUsageHeldWakeups(db, configA)).toBe(0);
	});

	it('releases the lifted credential only, oldest first and spaced apart', async () => {
		const held = { reason: WakeupSkipReason.ProviderUsageLimit, holdMin: 180 };
		const oldest = await wakeup({ ...held, heldOn: configA, ageMin: 30 });
		const middle = await wakeup({ ...held, heldOn: configA, ageMin: 20 });
		const newest = await wakeup({ ...held, heldOn: configA, ageMin: 10 });
		const otherCredential = await wakeup({ ...held, heldOn: configB, ageMin: 40 });

		expect(await releaseUsageHeldWakeups(db, configA)).toBe(3);

		// The oldest may go now; the rest follow one spacing apart.
		expect(await selectable()).toEqual([oldest]);
		expect(await secondsUntil(middle)).toBe(USAGE_HOLD_RELEASE_SPACING_SEC);
		expect(await secondsUntil(newest)).toBe(2 * USAGE_HOLD_RELEASE_SPACING_SEC);
		// Another credential's allowance has not come back, so its work stays held.
		expect(await secondsUntil(otherCredential)).toBeGreaterThan(170 * 60);
	});

	it('releases a wakeup held before its credential was recorded on any lift', async () => {
		const unrecorded = await wakeup({ reason: WakeupSkipReason.ProviderUsageLimit, holdMin: 60 });
		expect(await releaseUsageHeldWakeups(db, configB)).toBe(1);
		expect(await selectable()).toEqual([unrecorded]);
	});

	it('records the held credential on handback, and a later handback without one clears it', async () => {
		const id = await wakeup({ status: 'claimed' });
		await settleWakeupForRun(db, id, {
			kind: 'handback',
			reason: WakeupSkipReason.ProviderUsageLimit,
			notBefore: new Date(Date.now() + 60 * 60_000),
			heldConfigId: configA,
		});
		const heldOn = async () =>
			(
				await db.query<{ held_config_id: string | null }>(
					'SELECT held_config_id FROM agent_wakeup_requests WHERE id = $1',
					[id],
				)
			).rows[0].held_config_id;
		expect(await heldOn()).toBe(configA);

		await db.query(`UPDATE agent_wakeup_requests SET status = 'claimed' WHERE id = $1`, [id]);
		await settleWakeupForRun(db, id, {
			kind: 'handback',
			reason: WakeupSkipReason.InstanceAtCapacity,
		});
		expect(await heldOn()).toBeNull();
	});
});
