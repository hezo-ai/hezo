import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '040_run_log_compaction.sql';

describe('040_run_log_compaction migration', () => {
	let h: DataPreservationHarness;
	let runId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 039

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Worker') RETURNING id`,
			[teamId],
		);
		const memberId = member.rows[0].id;
		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, log_text, finished_at)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, $3, now()) RETURNING id`,
			[teamId, memberId, 'verbose log line 1\nverbose log line 2\n[done] succeeded'],
		);
		runId = run.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds a nullable log_compacted_at column', async () => {
		const cols = await h.db.query<{
			column_name: string;
			is_nullable: string;
			data_type: string;
		}>(
			`SELECT column_name, is_nullable, data_type FROM information_schema.columns
			 WHERE table_name = 'heartbeat_runs' AND column_name = 'log_compacted_at'`,
		);
		expect(cols.rows).toHaveLength(1);
		expect(cols.rows[0].is_nullable).toBe('YES');
		expect(cols.rows[0].data_type).toBe('timestamp with time zone');
	});

	it('adds the partial index used by the compaction scan', async () => {
		const idx = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes
			 WHERE tablename = 'heartbeat_runs' AND indexname = 'idx_runs_compaction'`,
		);
		expect(idx.rows).toHaveLength(1);
	});

	it('preserves pre-existing runs with their log intact and uncompacted', async () => {
		const run = await h.db.query<{ log_text: string; log_compacted_at: string | null }>(
			`SELECT log_text, log_compacted_at FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		expect(run.rows[0].log_text).toBe('verbose log line 1\nverbose log line 2\n[done] succeeded');
		expect(run.rows[0].log_compacted_at).toBeNull();
	});

	it('accepts a compaction timestamp on subsequent writes', async () => {
		await h.db.query(
			`UPDATE heartbeat_runs SET log_text = $1, log_compacted_at = now() WHERE id = $2`,
			['[log compacted]\n[done] succeeded', runId],
		);
		const run = await h.db.query<{ log_text: string; log_compacted_at: string | null }>(
			`SELECT log_text, log_compacted_at FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		expect(run.rows[0].log_text).toBe('[log compacted]\n[done] succeeded');
		expect(run.rows[0].log_compacted_at).not.toBeNull();
	});
});
