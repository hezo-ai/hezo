import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '055_asset_search.sql';

/** Does the row's generated tsvector match this as-you-type query term? */
async function matches(h: DataPreservationHarness, assetId: string, term: string) {
	const r = await h.db.query<{ m: boolean }>(
		`SELECT search_tsv @@ to_tsquery('english', $2) AS m FROM assets WHERE id = $1`,
		[assetId, term],
	);
	return r.rows[0].m;
}

describe('055_asset_search migration', () => {
	let h: DataPreservationHarness;
	let markdownId: string;
	let imageId: string;
	let accentedId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// Seed representative assets at schema 054 (no search columns yet).
		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Main', 'main', 'MA') RETURNING id`,
			[teamId],
		);
		const projectId = project.rows[0].id;

		const seed = async (contentType: string, filename: string) => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
				 VALUES ($1, $2, $3, 4096, 'deadbeef', $4) RETURNING id`,
				[teamId, projectId, contentType, filename],
			);
			return r.rows[0].id;
		};
		markdownId = await seed('text/markdown', 'notes.md');
		imageId = await seed('image/png', 'launch/hero-image.png');
		accentedId = await seed('application/pdf', 'résumé-final.pdf');

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds search_text and a generated search_tsv with its GIN index', async () => {
		const cols = await h.db.query<{
			column_name: string;
			is_nullable: string;
			is_generated: string;
		}>(
			`SELECT column_name, is_nullable, is_generated FROM information_schema.columns
			 WHERE table_name = 'assets' AND column_name IN ('search_text', 'search_tsv')`,
		);
		const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
		expect(byName.search_text?.is_nullable).toBe('YES');
		expect(byName.search_text?.is_generated).toBe('NEVER');
		expect(byName.search_tsv?.is_generated).toBe('ALWAYS');

		const idx = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE tablename = 'assets'`,
		);
		expect(idx.rows.map((r) => r.indexname)).toContain('idx_assets_search_tsv');
	});

	it('preserves pre-existing asset rows', async () => {
		const kept = await h.db.query<{
			id: string;
			original_filename: string;
			content_type: string;
			sha256: string;
			byte_size: string;
		}>(
			`SELECT id, original_filename, content_type, sha256, byte_size
			 FROM assets ORDER BY original_filename`,
		);
		expect(kept.rows).toHaveLength(3);
		expect(kept.rows.map((r) => r.original_filename)).toEqual([
			'launch/hero-image.png',
			'notes.md',
			'résumé-final.pdf',
		]);
		for (const row of kept.rows) {
			expect(row.sha256).toBe('deadbeef');
			expect(Number(row.byte_size)).toBe(4096);
		}
	});

	it('leaves search_text NULL - only a write can fill it', async () => {
		// Asset bytes live outside the database, so the migration has nothing to
		// extract from. Existing rows stay filename-searchable until next saved.
		const r = await h.db.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM assets WHERE search_text IS NOT NULL`,
		);
		expect(Number(r.rows[0].n)).toBe(0);
	});

	it('indexes every segment, word and extension of a foldered filename', async () => {
		// The whole point of normalizing: raw tokenization emits
		// `launch/hero-image.png` as ONE lexeme, so none of these would match.
		for (const term of ['launch:*', 'hero:*', 'image:*', 'png:*']) {
			expect(await matches(h, imageId, term), term).toBe(true);
		}
		expect(await matches(h, imageId, 'notes:*')).toBe(false);
	});

	it('keeps non-ASCII filenames searchable', async () => {
		// The raw copy of the filename carries these; the ASCII-only normalization
		// alone would have reduced `résumé` to `r sum`.
		expect(await matches(h, accentedId, 'résumé:*')).toBe(true);
		expect(await matches(h, accentedId, 'final:*')).toBe(true);
		expect(await matches(h, accentedId, 'pdf:*')).toBe(true);
	});

	it('recomputes the tsvector when an asset is renamed', async () => {
		// Pins the claim that move_project_asset needs no code change.
		await h.db.query(
			`UPDATE assets SET original_filename = 'archive/meeting-notes.txt'
		                  WHERE id = $1`,
			[markdownId],
		);
		expect(await matches(h, markdownId, 'archive:*')).toBe(true);
		expect(await matches(h, markdownId, 'meeting:*')).toBe(true);
		expect(await matches(h, markdownId, 'md:*')).toBe(false);
	});

	it('indexes search_text once written, below the filename in rank', async () => {
		await h.db.query(
			`UPDATE assets SET search_text = 'quarterly revenue projections' WHERE id = $1`,
			[imageId],
		);
		expect(await matches(h, imageId, 'revenue:*')).toBe(true);

		// Weight A (filename) must outrank weight B (content) for the same term.
		await h.db.query(`UPDATE assets SET search_text = 'hero' WHERE id = $1`, [markdownId]);
		const ranked = await h.db.query<{ id: string; score: number }>(
			`SELECT id, ts_rank(search_tsv, to_tsquery('english', 'hero:*')) AS score
			 FROM assets WHERE search_tsv @@ to_tsquery('english', 'hero:*') ORDER BY score DESC`,
		);
		expect(ranked.rows[0].id).toBe(imageId);
	});

	it('accepts a search_text longer than the extractor cap', async () => {
		// The generated column's left() is the backstop for a writer that bypasses
		// the app cap (a hand-written INSERT, a restore from a future version).
		await expect(
			h.db.query(`UPDATE assets SET search_text = repeat('alpha ', 100000) WHERE id = $1`, [
				accentedId,
			]),
		).resolves.toBeDefined();
		expect(await matches(h, accentedId, 'alpha:*')).toBe(true);
	});
});
