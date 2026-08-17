import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '063_runs_list_clock_index.sql';

describe('063_runs_list_clock_index migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let memberId: string;
	let oldFailedId: string;
	let recentSucceededId: string;
	let oldestSucceededId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 063

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Worker') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;

		// The shape the ordering bug turned on: a run that failed before it ever
		// went running has no started_at, so under `ORDER BY started_at DESC` it
		// sorted above every started run no matter how old it was.
		const oldFailed = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, created_at, finished_at, exit_code)
			 VALUES ($1, $2, 'failed'::heartbeat_run_status,
			         TIMESTAMPTZ '2026-01-01 09:00:00Z', TIMESTAMPTZ '2026-01-01 09:00:05Z', -1)
			 RETURNING id`,
			[teamId, memberId],
		);
		oldFailedId = oldFailed.rows[0].id;
		const recent = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, created_at, started_at, finished_at, exit_code)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status,
			         TIMESTAMPTZ '2026-01-05 11:00:00Z', TIMESTAMPTZ '2026-01-05 11:00:02Z',
			         TIMESTAMPTZ '2026-01-05 11:06:00Z', 0)
			 RETURNING id`,
			[teamId, memberId],
		);
		recentSucceededId = recent.rows[0].id;
		const oldest = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, created_at, started_at, finished_at, exit_code)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status,
			         TIMESTAMPTZ '2025-12-30 08:00:00Z', TIMESTAMPTZ '2025-12-30 08:00:01Z',
			         TIMESTAMPTZ '2025-12-30 08:04:00Z', 0)
			 RETURNING id`,
			[teamId, memberId],
		);
		oldestSucceededId = oldest.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the member/clock index over the coalesced timestamp', async () => {
		const r = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_runs_member_clock'`,
		);
		expect(r.rows.length).toBe(1);
		const def = r.rows[0].indexdef.toLowerCase();
		expect(def).toContain('member_id');
		expect(def).toContain('coalesce');
		expect(def).toContain('started_at');
		expect(def).toContain('created_at');
		// Partial would hide whole runs from a list that says it shows all of them.
		expect(def).not.toContain('where');
	});

	it('preserves every pre-existing run row, including the one with no started_at', async () => {
		const kept = await h.db.query<{ id: string; started_at: string | null; status: string }>(
			`SELECT id, started_at, status::text AS status FROM heartbeat_runs
			  WHERE team_id = $1 ORDER BY created_at`,
			[teamId],
		);
		expect(kept.rows.length).toBe(3);
		expect(kept.rows.map((r) => r.id)).toEqual([oldestSucceededId, oldFailedId, recentSucceededId]);
		expect(kept.rows.map((r) => r.status)).toEqual(['succeeded', 'failed', 'succeeded']);
		expect(kept.rows[1].started_at).toBeNull();
	});

	it('orders the list by the clock each row shows, newest first', async () => {
		const r = await h.db.query<{ id: string }>(
			`SELECT id FROM heartbeat_runs
			  WHERE member_id = $1
			  ORDER BY COALESCE(started_at, created_at) DESC, id DESC`,
			[memberId],
		);
		// The never-started failure takes its place by date rather than jumping the
		// whole list, which is what DESC's NULLS FIRST used to do to it.
		expect(r.rows.map((x) => x.id)).toEqual([recentSucceededId, oldFailedId, oldestSucceededId]);
	});
});
