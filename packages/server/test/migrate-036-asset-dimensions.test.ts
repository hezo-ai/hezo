import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '036_asset_dimensions.sql';

describe('036_asset_dimensions migration', () => {
	let h: DataPreservationHarness;
	let seededAssetId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// Seed a representative asset row at schema 035 (no width/height yet).
		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Main', 'main', 'MA') RETURNING id`,
			[teamId],
		);
		const asset = await h.db.query<{ id: string }>(
			`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
			 VALUES ($1, $2, 'image/png', 83287, 'deadbeef', 'launch/hero.png') RETURNING id`,
			[teamId, project.rows[0].id],
		);
		seededAssetId = asset.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds nullable width/height columns to assets', async () => {
		const cols = await h.db.query<{ column_name: string; is_nullable: string; data_type: string }>(
			`SELECT column_name, is_nullable, data_type FROM information_schema.columns
			 WHERE table_name = 'assets' AND column_name IN ('width', 'height')`,
		);
		const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
		expect(byName.width?.is_nullable).toBe('YES');
		expect(byName.height?.is_nullable).toBe('YES');
		expect(byName.width?.data_type).toBe('integer');
		expect(byName.height?.data_type).toBe('integer');
	});

	it('preserves pre-existing asset rows, defaulting dimensions to null', async () => {
		const kept = await h.db.query<{
			original_filename: string;
			byte_size: string;
			width: number | null;
			height: number | null;
		}>(`SELECT original_filename, byte_size, width, height FROM assets WHERE id = $1`, [
			seededAssetId,
		]);
		expect(kept.rows.length).toBe(1);
		expect(kept.rows[0].original_filename).toBe('launch/hero.png');
		expect(Number(kept.rows[0].byte_size)).toBe(83287);
		expect(kept.rows[0].width).toBeNull();
		expect(kept.rows[0].height).toBeNull();
	});

	it('stores width/height on assets after the migration', async () => {
		const r = await h.db.query<{ width: number; height: number }>(
			`UPDATE assets SET width = 1600, height = 1200 WHERE id = $1 RETURNING width, height`,
			[seededAssetId],
		);
		expect(r.rows[0].width).toBe(1600);
		expect(r.rows[0].height).toBe(1200);
	});
});
