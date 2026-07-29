import { ACTIVE_WAKEUP_STATUSES, TERMINAL_WAKEUP_STATUSES, WakeupStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import {
	ANALYZE_TABLES,
	analyzeHotTables,
	sweepTerminalWakeups,
} from '../src/services/db-maintenance';
import { safeClose } from './helpers';
import { createTestApp, createTestProject, createTestTeam } from './helpers/app';

let db: Db;
let teamId: string;
let memberId: string;

/** Insert a wakeup at a given status and age; returns its id. */
async function seedWakeup(status: WakeupStatus, ageDays: number): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (team_id, member_id, source, status, created_at)
		 VALUES ($1, $2, 'timer', $3::wakeup_status, now() - ($4 || ' days')::interval)
		 RETURNING id`,
		[teamId, memberId, status, String(ageDays)],
	);
	return r.rows[0].id;
}

const alive = async (id: string): Promise<boolean> => {
	const r = await db.query(`SELECT 1 FROM agent_wakeup_requests WHERE id = $1`, [id]);
	return r.rows.length === 1;
};

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	const teamRes = await createTestTeam(db, { name: 'Maint Co' });
	teamId = (await teamRes.json()).data.id;
	await createTestProject(db, teamId, { name: 'Maint Project' });

	// `member_agents.id` IS a `members.id` (subtype table), and team membership
	// lives on `members`.
	const m = await db.query<{ id: string }>(
		`SELECT m.id FROM members m
		 JOIN member_agents ma ON ma.id = m.id
		 WHERE m.team_id = $1 LIMIT 1`,
		[teamId],
	);
	memberId = m.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('sweepTerminalWakeups', () => {
	it('deletes only terminal rows past the retention window', async () => {
		const oldTerminal = await Promise.all(TERMINAL_WAKEUP_STATUSES.map((s) => seedWakeup(s, 30)));
		const oldActive = await Promise.all(ACTIVE_WAKEUP_STATUSES.map((s) => seedWakeup(s, 30)));
		const recentTerminal = await Promise.all(TERMINAL_WAKEUP_STATUSES.map((s) => seedWakeup(s, 1)));

		const deleted = await sweepTerminalWakeups(db, 7);
		expect(deleted).toBe(TERMINAL_WAKEUP_STATUSES.length);

		for (const id of oldTerminal) expect(await alive(id)).toBe(false);
		// An old `deferred` wakeup is still pending work - a cleared blocker
		// re-queues it - so age alone must never make it collectable.
		for (const id of oldActive) expect(await alive(id)).toBe(true);
		// Inside the window, a terminal row is kept so a recent dispatch stays
		// debuggable.
		for (const id of recentTerminal) expect(await alive(id)).toBe(true);
	});

	it('is a no-op when nothing is old enough, and writes no rows', async () => {
		const id = await seedWakeup(WakeupStatus.Completed, 0);
		expect(await sweepTerminalWakeups(db, 7)).toBe(0);
		expect(await alive(id)).toBe(true);
	});

	it('honours a caller-supplied retention window', async () => {
		// Assert on this row rather than the pass's total: earlier cases in this
		// file leave their own rows behind, and the contract is about which row
		// each window covers, not how many happen to be present.
		const id = await seedWakeup(WakeupStatus.Completed, 3);
		await sweepTerminalWakeups(db, 7);
		expect(await alive(id)).toBe(true);
		await sweepTerminalWakeups(db, 1);
		expect(await alive(id)).toBe(false);
	});
});

describe('analyzeHotTables', () => {
	it('analyzes every listed table - a name that does not exist is a silent no-op', async () => {
		// The per-table catch means a typo'd name degrades to a warning and the
		// table simply never gets analyzed, which is the failure this asserts
		// against: the count must equal the list, not merely be non-zero.
		expect(await analyzeHotTables(db)).toBe(ANALYZE_TABLES.length);
	});

	it('leaves every row intact', async () => {
		const before = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM agent_wakeup_requests`,
		);
		await analyzeHotTables(db);
		const after = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM agent_wakeup_requests`,
		);
		expect(after.rows[0].c).toBe(before.rows[0].c);
	});

	it('does nothing on external Postgres, where autovacuum already analyzes', async () => {
		const external = { ...db, kind: 'postgres' as const };
		expect(await analyzeHotTables(external as Db)).toBe(0);
	});
});
