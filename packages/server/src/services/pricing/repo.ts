/**
 * `model_pricing` table access. Feed rows (`source='litellm'`) and operator
 * overrides (`source='manual'`) are upserted on the `(model_id, source)` key;
 * the service decides precedence (manual wins) at read time.
 */
import type { PGlite } from '@electric-sql/pglite';
import { withTransaction } from '../../lib/sql';
import type { ParsedRate } from './feed';

export interface ModelPricingRow {
	id: string;
	model_id: string;
	input_per_token: number;
	output_per_token: number;
	cache_read_per_token: number | null;
	cache_creation_per_token: number | null;
	source: 'litellm' | 'manual';
	updated_at: string;
}

export interface ManualRateInput {
	model_id: string;
	input_per_token: number;
	output_per_token: number;
	cache_read_per_token?: number | null;
	cache_creation_per_token?: number | null;
}

export async function countModelPricing(db: PGlite): Promise<number> {
	const r = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM model_pricing');
	return r.rows[0]?.c ?? 0;
}

export async function listModelPricing(db: PGlite): Promise<ModelPricingRow[]> {
	const r = await db.query<ModelPricingRow>(
		'SELECT * FROM model_pricing ORDER BY model_id ASC, source ASC',
	);
	return r.rows;
}

/**
 * Bulk-upsert feed rows. Runs in a single transaction, chunked so a parameter
 * blowout (the feed is ~1.5k models) can't exceed a statement's bind limit.
 * Only touches `source='litellm'` rows — operator overrides are never clobbered.
 */
export async function upsertFeedRates(db: PGlite, rates: ParsedRate[]): Promise<void> {
	if (rates.length === 0) return;
	const CHUNK = 100;
	await withTransaction(db, async () => {
		for (let i = 0; i < rates.length; i += CHUNK) {
			const chunk = rates.slice(i, i + CHUNK);
			const values: string[] = [];
			const params: unknown[] = [];
			chunk.forEach((rate, j) => {
				const b = j * 5;
				values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, 'litellm', now())`);
				params.push(
					rate.modelId,
					rate.inputPerToken,
					rate.outputPerToken,
					rate.cacheReadPerToken,
					rate.cacheCreationPerToken,
				);
			});
			await db.query(
				`INSERT INTO model_pricing
				   (model_id, input_per_token, output_per_token, cache_read_per_token, cache_creation_per_token, source, updated_at)
				 VALUES ${values.join(', ')}
				 ON CONFLICT (model_id, source) DO UPDATE SET
				   input_per_token = EXCLUDED.input_per_token,
				   output_per_token = EXCLUDED.output_per_token,
				   cache_read_per_token = EXCLUDED.cache_read_per_token,
				   cache_creation_per_token = EXCLUDED.cache_creation_per_token,
				   updated_at = now()`,
				params,
			);
		}
	});
}

/** Insert or update a single operator override row (`source='manual'`). */
export async function upsertManualRate(
	db: PGlite,
	input: ManualRateInput,
): Promise<ModelPricingRow> {
	const r = await db.query<ModelPricingRow>(
		`INSERT INTO model_pricing
		   (model_id, input_per_token, output_per_token, cache_read_per_token, cache_creation_per_token, source, updated_at)
		 VALUES ($1, $2, $3, $4, $5, 'manual', now())
		 ON CONFLICT (model_id, source) DO UPDATE SET
		   input_per_token = EXCLUDED.input_per_token,
		   output_per_token = EXCLUDED.output_per_token,
		   cache_read_per_token = EXCLUDED.cache_read_per_token,
		   cache_creation_per_token = EXCLUDED.cache_creation_per_token,
		   updated_at = now()
		 RETURNING *`,
		[
			input.model_id,
			input.input_per_token,
			input.output_per_token,
			input.cache_read_per_token ?? null,
			input.cache_creation_per_token ?? null,
		],
	);
	return r.rows[0];
}

/** Delete an override row by id. Only manual rows are deletable. */
export async function deleteManualRate(db: PGlite, id: string): Promise<boolean> {
	const r = await db.query(
		"DELETE FROM model_pricing WHERE id = $1 AND source = 'manual' RETURNING id",
		[id],
	);
	return r.rows.length > 0;
}
