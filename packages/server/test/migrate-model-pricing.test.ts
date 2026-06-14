import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDbWithMigrations } from './helpers/db';

let db: PGlite;

beforeEach(async () => {
	db = await createTestDbWithMigrations();
});

afterEach(async () => {
	await db.close();
});

describe('005_model_pricing migration', () => {
	it('creates the model_pricing table with the expected columns', async () => {
		const r = await db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'model_pricing'`,
		);
		const cols = r.rows.map((row) => row.column_name).sort();
		expect(cols).toEqual(
			[
				'cache_creation_per_token',
				'cache_read_per_token',
				'id',
				'input_per_token',
				'model_id',
				'output_per_token',
				'source',
				'updated_at',
			].sort(),
		);
	});

	it('allows feed and manual rows to coexist for one model_id', async () => {
		await db.query(
			`INSERT INTO model_pricing (model_id, input_per_token, output_per_token, source)
			 VALUES ('m', 1e-6, 2e-6, 'litellm'), ('m', 9e-6, 9e-6, 'manual')`,
		);
		const r = await db.query<{ c: number }>(
			"SELECT COUNT(*)::int AS c FROM model_pricing WHERE model_id = 'm'",
		);
		expect(r.rows[0].c).toBe(2);
	});

	it('enforces UNIQUE(model_id, source)', async () => {
		await db.query(
			"INSERT INTO model_pricing (model_id, input_per_token, output_per_token, source) VALUES ('dup', 1e-6, 2e-6, 'manual')",
		);
		await expect(
			db.query(
				"INSERT INTO model_pricing (model_id, input_per_token, output_per_token, source) VALUES ('dup', 3e-6, 4e-6, 'manual')",
			),
		).rejects.toThrow();
	});

	it('rejects an out-of-domain source via the CHECK constraint', async () => {
		await expect(
			db.query(
				"INSERT INTO model_pricing (model_id, input_per_token, output_per_token, source) VALUES ('x', 1e-6, 2e-6, 'bogus')",
			),
		).rejects.toThrow();
	});
});
