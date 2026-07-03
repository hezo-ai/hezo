import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '013_run_cache_token_columns.sql';

describe('013_run_cache_token_columns migration', () => {
	let h: DataPreservationHarness;
	let seededRunId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Engineer') RETURNING id`,
			[team.rows[0].id],
		);
		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, input_tokens, output_tokens, cost_cents)
			 VALUES ($1, $2, 'succeeded', 4046220, 11565, 367) RETURNING id`,
			[team.rows[0].id, member.rows[0].id],
		);
		seededRunId = run.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the cache token columns with default 0', async () => {
		const cols = await h.db.query<{ column_name: string; column_default: string | null }>(
			`SELECT column_name, column_default FROM information_schema.columns
			 WHERE table_name = 'heartbeat_runs'
			   AND column_name IN ('cache_read_tokens', 'cache_creation_tokens')
			 ORDER BY column_name`,
		);
		expect(cols.rows.map((r) => r.column_name)).toEqual([
			'cache_creation_tokens',
			'cache_read_tokens',
		]);
		for (const row of cols.rows) expect(row.column_default).toBe('0');
	});

	it('preserves pre-existing run rows, defaulting the new columns to 0', async () => {
		const kept = await h.db.query<{
			input_tokens: number;
			output_tokens: number;
			cost_cents: number;
			cache_read_tokens: number;
			cache_creation_tokens: number;
		}>(
			`SELECT input_tokens::int AS input_tokens, output_tokens::int AS output_tokens,
			        cost_cents, cache_read_tokens::int AS cache_read_tokens,
			        cache_creation_tokens::int AS cache_creation_tokens
			 FROM heartbeat_runs WHERE id = $1`,
			[seededRunId],
		);
		expect(kept.rows).toHaveLength(1);
		expect(kept.rows[0]).toEqual({
			input_tokens: 4046220,
			output_tokens: 11565,
			cost_cents: 367,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
		});
	});

	it('accepts writes to the new columns', async () => {
		await h.db.query(
			`UPDATE heartbeat_runs SET cache_read_tokens = 3900000, cache_creation_tokens = 120000 WHERE id = $1`,
			[seededRunId],
		);
		const r = await h.db.query<{ cache_read_tokens: number }>(
			`SELECT cache_read_tokens::int AS cache_read_tokens FROM heartbeat_runs WHERE id = $1`,
			[seededRunId],
		);
		expect(r.rows[0].cache_read_tokens).toBe(3900000);
	});
});
