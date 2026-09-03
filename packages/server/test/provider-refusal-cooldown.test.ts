// What the provider-refusal cooldown fragment selects, against real rows.
//
// Kept apart from `job-manager-scheduling.test.ts`, which proves the fragment is
// wired into the wakeup scan with one case. The semantics need several, and
// asserting them through `processWakeups` would dispatch a real agent per case
// to observe a row that was *not* held.

import { WakeupSkipReason } from '@hezo/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { providerRefusalCooldownSql } from '../src/services/no-work-backoff';
import { safeClose } from './helpers';
import { createTestApp, createTestTeam } from './helpers/app';

let db: Db;
let teamId: string;
let memberId: string;

/** Insert a queued wakeup, optionally already skipped for `reason` `agoMin` ago. */
async function wakeup(reason?: string, agoMin = 0): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests
		   (member_id, team_id, source, status, payload, last_skipped_reason, last_skipped_at)
		 VALUES ($1, $2, 'timer', 'queued', '{}'::jsonb, $3,
		         CASE WHEN $3::text IS NULL THEN NULL
		              ELSE now() - ($4 || ' minutes')::interval END)
		 RETURNING id`,
		[memberId, teamId, reason ?? null, String(agoMin)],
	);
	return r.rows[0].id;
}

/** The ids the scan would still consider, in the order it takes them. */
async function selectable(): Promise<string[]> {
	const r = await db.query<{ id: string }>(
		`SELECT id FROM agent_wakeup_requests
		  WHERE team_id = $1 AND status = 'queued' AND ${providerRefusalCooldownSql()}
		  ORDER BY created_at ASC`,
		[teamId],
	);
	return r.rows.map((x) => x.id);
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

describe('providerRefusalCooldownSql', () => {
	it('keeps a wakeup that has never been skipped', async () => {
		// The three-valued-logic trap this exists to avoid: a NULL
		// `last_skipped_reason` makes every arm NULL, so a bare `NOT (...)` is NULL,
		// and a WHERE drops the row - filtering out the entire ordinary queue.
		const id = await wakeup();
		expect(await selectable()).toEqual([id]);
	});

	it('keeps a wakeup skipped for a reason that is not a provider refusal', async () => {
		const id = await wakeup(WakeupSkipReason.InstanceAtCapacity);
		expect(await selectable()).toEqual([id]);
	});

	it('holds a capacity refusal, then releases it once its clock runs out', async () => {
		const fresh = await wakeup(WakeupSkipReason.ProviderAtCapacity, 1);
		expect(await selectable()).not.toContain(fresh);

		const expired = await wakeup(WakeupSkipReason.ProviderAtCapacity, 10);
		expect(await selectable()).toEqual([expired]);
	});

	it('gives a spent usage allowance a longer clock than a capacity refusal', async () => {
		// Ten minutes clears capacity but not a subscription window, which resets in
		// hours - the whole reason the two are separate reasons rather than one.
		const usage = await wakeup(WakeupSkipReason.ProviderUsageLimit, 10);
		expect(await selectable()).not.toContain(usage);

		const capacity = await wakeup(WakeupSkipReason.ProviderAtCapacity, 10);
		expect(await selectable()).toEqual([capacity]);
	});

	it('does not let held wakeups crowd a fresh one out of the scan window', async () => {
		// Why the filter is in the scan's WHERE rather than a `continue` in the
		// dispatch loop: the scan takes the ten OLDEST queued wakeups, so held rows
		// are by then old rows and would fill the window on every tick, starving
		// newer work for as long as the outage lasted.
		for (let i = 0; i < 10; i++) await wakeup(WakeupSkipReason.ProviderAtCapacity, 1);
		const fresh = await wakeup();

		const r = await db.query<{ id: string }>(
			`SELECT id FROM agent_wakeup_requests
			  WHERE team_id = $1 AND status = 'queued' AND ${providerRefusalCooldownSql()}
			  ORDER BY created_at ASC LIMIT 10`,
			[teamId],
		);
		expect(r.rows.map((x) => x.id)).toEqual([fresh]);
	});
});
