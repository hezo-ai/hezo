import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '014_pricepertoken_model_pricing.sql';

describe('014_pricepertoken_model_pricing migration', () => {
	let h: DataPreservationHarness;
	let manualId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 013 — 'litellm' still the feed source

		// A stale feed row (must be dropped) and an operator override with cache
		// rates (must survive byte-for-byte).
		await h.db.query(
			`INSERT INTO model_pricing (model_id, input_per_token, output_per_token, source)
			 VALUES ('stale-feed-model', 1e-6, 2e-6, 'litellm')`,
		);
		const manual = await h.db.query<{ id: string }>(
			`INSERT INTO model_pricing
			   (model_id, input_per_token, output_per_token, cache_read_per_token, cache_creation_per_token, source)
			 VALUES ('my-tuned-model', 9e-6, 1.8e-5, 9e-7, 1.125e-5, 'manual') RETURNING id`,
		);
		manualId = manual.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('drops the old litellm feed rows', async () => {
		const r = await h.db.query(`SELECT 1 FROM model_pricing WHERE model_id = 'stale-feed-model'`);
		expect(r.rows.length).toBe(0);
		const any = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM model_pricing WHERE source = 'litellm'`,
		);
		expect(any.rows[0].c).toBe(0);
	});

	it('preserves manual overrides with their exact values', async () => {
		const r = await h.db.query<{
			model_id: string;
			input_per_token: number;
			output_per_token: number;
			cache_read_per_token: number | null;
			cache_creation_per_token: number | null;
			source: string;
		}>(`SELECT * FROM model_pricing WHERE id = $1`, [manualId]);
		expect(r.rows.length).toBe(1);
		expect(r.rows[0]).toMatchObject({
			model_id: 'my-tuned-model',
			input_per_token: 9e-6,
			output_per_token: 1.8e-5,
			cache_read_per_token: 9e-7,
			cache_creation_per_token: 1.125e-5,
			source: 'manual',
		});
	});

	it('bakes in the pricepertoken catalog so pricing works before any fetch', async () => {
		const count = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM model_pricing WHERE source = 'pricepertoken'`,
		);
		expect(count.rows[0].c).toBeGreaterThan(400);

		// Spot-check the models Hezo's runtime adapters pin, with sane rates.
		const majors = await h.db.query<{ model_id: string; i: number; o: number }>(
			`SELECT model_id, input_per_token AS i, output_per_token AS o FROM model_pricing
			 WHERE model_id = ANY($1) AND source = 'pricepertoken' ORDER BY model_id`,
			[['claude-opus-4.8', 'deepseek-v4-pro', 'deepseek-v4-flash', 'glm-4.7', 'kimi-k2.7-code']],
		);
		expect(majors.rows.map((r) => r.model_id)).toEqual([
			'claude-opus-4.8',
			'deepseek-v4-flash',
			'deepseek-v4-pro',
			'glm-4.7',
			'kimi-k2.7-code',
		]);
		for (const row of majors.rows) {
			// Per-token rates: positive and below $0.001/token ($1000/Mtok).
			expect(row.i).toBeGreaterThan(0);
			expect(row.i).toBeLessThan(0.001);
			expect(row.o).toBeGreaterThan(0);
			expect(row.o).toBeLessThan(0.001);
		}
		// claude-opus-4.8 at its known list price: $5/Mtok in, $25/Mtok out.
		const opus = majors.rows.find((r) => r.model_id === 'claude-opus-4.8');
		expect(opus?.i).toBe(5e-6);
		expect(opus?.o).toBe(2.5e-5);
	});

	it('bakes rows without cache rates (the catalog carries none)', async () => {
		const r = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM model_pricing
			 WHERE source = 'pricepertoken'
			   AND (cache_read_per_token IS NOT NULL OR cache_creation_per_token IS NOT NULL)`,
		);
		expect(r.rows[0].c).toBe(0);
	});

	it("retags the source domain: 'litellm' rejected, 'pricepertoken' accepted and default", async () => {
		await expect(
			h.db.query(
				`INSERT INTO model_pricing (model_id, input_per_token, output_per_token, source)
				 VALUES ('nope', 1e-6, 2e-6, 'litellm')`,
			),
		).rejects.toThrow(/model_pricing_source_check/);

		await h.db.query(
			`INSERT INTO model_pricing (model_id, input_per_token, output_per_token, source)
			 VALUES ('explicit-ppt', 1e-6, 2e-6, 'pricepertoken')`,
		);

		// Omitting source now defaults to 'pricepertoken'.
		const defaulted = await h.db.query<{ source: string }>(
			`INSERT INTO model_pricing (model_id, input_per_token, output_per_token)
			 VALUES ('defaulted-row', 1e-6, 2e-6) RETURNING source`,
		);
		expect(defaulted.rows[0].source).toBe('pricepertoken');
	});
});
