import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '077_notional_cost_and_run_model.sql';

describe('077_notional_cost_and_run_model migration', () => {
	let h: DataPreservationHarness;
	let costEntryId: string;
	let runId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 077

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Chief') RETURNING id`,
			[teamId],
		);
		const memberId = member.rows[0].id;

		// Real spend recorded before the split existed.
		const cost = await h.db.query<{ id: string }>(
			`INSERT INTO cost_entries (member_id, amount_cents, description)
			 VALUES ($1, 250, 'Agent run') RETURNING id`,
			[memberId],
		);
		costEntryId = cost.rows[0].id;

		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, input_tokens, output_tokens)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, 1000, 100) RETURNING id`,
			[teamId, memberId],
		);
		runId = run.rows[0].id;

		// An OpenAI feed row with no cache rates, and an operator override that the
		// backfill must not touch.
		// Upserts, not inserts: migration 014 already seeds this catalog, and the
		// point is to pin the rates the backfill then derives from.
		await h.db.query(
			`INSERT INTO model_pricing (model_id, input_per_token, output_per_token, source)
			 VALUES ('gpt-5-codex', 0.00000125, 0.00001, 'pricepertoken')
			 ON CONFLICT (model_id, source) DO UPDATE
			   SET input_per_token = EXCLUDED.input_per_token,
			       output_per_token = EXCLUDED.output_per_token,
			       cache_read_per_token = NULL, cache_creation_per_token = NULL`,
		);
		await h.db.query(
			`INSERT INTO model_pricing
			   (model_id, input_per_token, output_per_token, cache_read_per_token, source)
			 VALUES ('gpt-5.2-codex', 0.00000175, 0.000014, NULL, 'manual')
			 ON CONFLICT (model_id, source) DO UPDATE
			   SET cache_read_per_token = NULL`,
		);
		// A row outside the enumerated list stays on the safe fallback.
		await h.db.query(
			`INSERT INTO model_pricing (model_id, input_per_token, output_per_token, source)
			 VALUES ('claude-opus-4.8', 0.000005, 0.000025, 'pricepertoken')
			 ON CONFLICT (model_id, source) DO UPDATE
			   SET cache_read_per_token = NULL, cache_creation_per_token = NULL`,
		);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('keeps every pre-existing cost entry, and reads it as real spend', async () => {
		const row = await h.db.query<{ amount_cents: number; billed: boolean }>(
			`SELECT amount_cents, billed FROM cost_entries WHERE id = $1`,
			[costEntryId],
		);
		expect(row.rows[0].amount_cents).toBe(250);
		// Defaulting true is the safe direction: history IS real spend, and the
		// alternative silently stops charging somebody's budget.
		expect(row.rows[0].billed).toBe(true);
	});

	it('keeps every pre-existing run, with no model claimed for it', async () => {
		const row = await h.db.query<{
			input_tokens: string;
			model: string | null;
			cost_billed: boolean;
		}>(`SELECT input_tokens, model, cost_billed FROM heartbeat_runs WHERE id = $1`, [runId]);
		expect(Number(row.rows[0].input_tokens)).toBe(1000);
		// Unknowable after the fact - a subscription run's argv carries no model
		// either - so NULL rather than a guess.
		expect(row.rows[0].model).toBeNull();
		expect(row.rows[0].cost_billed).toBe(true);
	});

	it('derives OpenAI cache rates from each row own input price', async () => {
		const row = await h.db.query<{
			cache_read_per_token: string;
			cache_creation_per_token: string;
		}>(
			`SELECT cache_read_per_token, cache_creation_per_token
			 FROM model_pricing WHERE model_id = 'gpt-5-codex' AND source = 'pricepertoken'`,
		);
		expect(Number(row.rows[0].cache_read_per_token)).toBeCloseTo(0.00000125 * 0.1, 12);
		expect(Number(row.rows[0].cache_creation_per_token)).toBeCloseTo(0.00000125, 12);
	});

	it('leaves an operator override alone, and a provider outside the list on the fallback', async () => {
		const manual = await h.db.query<{ cache_read_per_token: string | null }>(
			`SELECT cache_read_per_token FROM model_pricing
			 WHERE model_id = 'gpt-5.2-codex' AND source = 'manual'`,
		);
		expect(manual.rows[0].cache_read_per_token).toBeNull();

		const other = await h.db.query<{ cache_read_per_token: string | null }>(
			`SELECT cache_read_per_token FROM model_pricing WHERE model_id = 'claude-opus-4.8'`,
		);
		expect(other.rows[0].cache_read_per_token).toBeNull();
	});

	it('indexes the budget gate on the column it now filters by', async () => {
		const idx = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE tablename = 'cost_entries'`,
		);
		const names = idx.rows.map((r) => r.indexname);
		expect(names).toContain('idx_costs_member_billed_created');
		expect(names).toContain('idx_costs_project_billed_created');
	});
});
