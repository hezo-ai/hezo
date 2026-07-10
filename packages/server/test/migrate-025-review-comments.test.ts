import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '025_review_comments.sql';

describe('025_review_comments migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	let documentId: string;
	let assetId: string;
	let seededCommentId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 024

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Demo', 'demo', 'DM') RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;
		const doc = await h.db.query<{ id: string }>(
			`INSERT INTO documents (team_id, project_id, type, slug, content)
			 VALUES ($1, $2, 'project_doc', 'spec.md', '# Spec') RETURNING id`,
			[teamId, projectId],
		);
		documentId = doc.rows[0].id;
		const comment = await h.db.query<{ id: string }>(
			`INSERT INTO document_review_comments (document_id, quote, occurrence, comment, doc_updated_at)
			 SELECT id, 'Spec', 2, 'Expand this heading', updated_at FROM documents WHERE id = $1
			 RETURNING id`,
			[documentId],
		);
		seededCommentId = comment.rows[0].id;
		const asset = await h.db.query<{ id: string }>(
			`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
			 VALUES ($1, $2, 'text/markdown', 12, 'abc123', 'notes.md') RETURNING id`,
			[teamId, projectId],
		);
		assetId = asset.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('renames the table and adds the asset columns', async () => {
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'review_comments' ORDER BY column_name`,
		);
		expect(cols.rows.map((r) => r.column_name)).toEqual([
			'asset_id',
			'asset_sha256',
			'author_member_id',
			'comment',
			'created_at',
			'doc_updated_at',
			'document_id',
			'id',
			'occurrence',
			'quote',
			'updated_at',
		]);

		const oldTable = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.tables
			 WHERE table_name = 'document_review_comments'`,
		);
		expect(oldTable.rows[0].c).toBe(0);

		const trigger = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.triggers
			 WHERE event_object_table = 'review_comments'
			   AND trigger_name = 'trg_review_comments_updated'`,
		);
		expect(trigger.rows[0].c).toBeGreaterThan(0);
	});

	it('preserves the pre-existing document review comment verbatim', async () => {
		const kept = await h.db.query<{
			document_id: string;
			quote: string;
			occurrence: number;
			comment: string;
			asset_id: string | null;
			asset_sha256: string | null;
		}>(`SELECT * FROM review_comments WHERE id = $1`, [seededCommentId]);
		expect(kept.rows.length).toBe(1);
		expect(kept.rows[0].document_id).toBe(documentId);
		expect(kept.rows[0].quote).toBe('Spec');
		expect(kept.rows[0].occurrence).toBe(2);
		expect(kept.rows[0].comment).toBe('Expand this heading');
		expect(kept.rows[0].asset_id).toBeNull();
		expect(kept.rows[0].asset_sha256).toBeNull();
	});

	it('accepts anchored and un-anchored asset comments', async () => {
		const anchored = await h.db.query<{ id: string }>(
			`INSERT INTO review_comments (asset_id, quote, occurrence, comment, asset_sha256)
			 VALUES ($1, 'a line', 0, 'tighten this', 'abc123') RETURNING id`,
			[assetId],
		);
		expect(anchored.rows.length).toBe(1);
		const wholeAsset = await h.db.query<{ id: string }>(
			`INSERT INTO review_comments (asset_id, comment, asset_sha256)
			 VALUES ($1, 'looks off overall', 'abc123') RETURNING id`,
			[assetId],
		);
		expect(wholeAsset.rows.length).toBe(1);
	});

	it('rejects rows violating the target and stamp constraints', async () => {
		// Both targets set.
		await expect(
			h.db.query(
				`INSERT INTO review_comments (document_id, asset_id, quote, occurrence, comment, doc_updated_at, asset_sha256)
				 SELECT $1, $2, 'x', 0, 'bad', updated_at, 'abc123' FROM documents WHERE id = $1`,
				[documentId, assetId],
			),
		).rejects.toThrow(/review_comments_one_target/);
		// Neither target set.
		await expect(
			h.db.query(`INSERT INTO review_comments (comment) VALUES ('bad')`),
		).rejects.toThrow(/review_comments_one_target/);
		// Doc comment without a quote.
		await expect(
			h.db.query(
				`INSERT INTO review_comments (document_id, comment, doc_updated_at)
				 SELECT id, 'bad', updated_at FROM documents WHERE id = $1`,
				[documentId],
			),
		).rejects.toThrow(/review_comments_doc_shape/);
		// Asset comment without the sha stamp.
		await expect(
			h.db.query(`INSERT INTO review_comments (asset_id, comment) VALUES ($1, 'bad')`, [assetId]),
		).rejects.toThrow(/review_comments_asset_stamp/);
	});

	it('cascades asset comments on asset delete', async () => {
		const scratch = await h.db.query<{ id: string }>(
			`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
			 VALUES ($1, $2, 'image/png', 5, 'def456', 'shot.png') RETURNING id`,
			[teamId, projectId],
		);
		await h.db.query(
			`INSERT INTO review_comments (asset_id, comment, asset_sha256) VALUES ($1, 'temp', 'def456')`,
			[scratch.rows[0].id],
		);
		await h.db.query(`DELETE FROM assets WHERE id = $1`, [scratch.rows[0].id]);
		const orphans = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM review_comments WHERE asset_id = $1`,
			[scratch.rows[0].id],
		);
		expect(orphans.rows[0].c).toBe(0);
	});
});
