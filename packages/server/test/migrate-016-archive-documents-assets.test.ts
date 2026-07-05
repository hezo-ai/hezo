import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '016_archive_documents_assets.sql';

describe('016_archive_documents_assets migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	let memberId: string;
	let docId: string;
	let assetId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 015

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
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Captain') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;
		const doc = await h.db.query<{ id: string }>(
			`INSERT INTO documents (team_id, project_id, type, slug, content)
			 VALUES ($1, $2, 'project_doc', 'spec.md', '# Spec') RETURNING id`,
			[teamId, projectId],
		);
		docId = doc.rows[0].id;
		const asset = await h.db.query<{ id: string }>(
			`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
			 VALUES ($1, $2, 'text/plain', 4, 'abcd', 'notes.txt') RETURNING id`,
			[teamId, projectId],
		);
		assetId = asset.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds nullable archived columns to documents and assets', async () => {
		for (const table of ['documents', 'assets']) {
			const cols = await h.db.query<{ column_name: string; is_nullable: string }>(
				`SELECT column_name, is_nullable FROM information_schema.columns
				 WHERE table_name = $1 AND column_name IN ('archived_at', 'archived_by_member_id')
				 ORDER BY column_name`,
				[table],
			);
			expect(cols.rows.map((r) => r.column_name)).toEqual(['archived_at', 'archived_by_member_id']);
			expect(cols.rows.every((r) => r.is_nullable === 'YES')).toBe(true);
		}
	});

	it('preserves pre-existing rows as active (archived_at NULL)', async () => {
		const doc = await h.db.query<{ content: string; archived_at: string | null }>(
			`SELECT content, archived_at FROM documents WHERE id = $1`,
			[docId],
		);
		expect(doc.rows[0].content).toBe('# Spec');
		expect(doc.rows[0].archived_at).toBeNull();

		const asset = await h.db.query<{ original_filename: string; archived_at: string | null }>(
			`SELECT original_filename, archived_at FROM assets WHERE id = $1`,
			[assetId],
		);
		expect(asset.rows[0].original_filename).toBe('notes.txt');
		expect(asset.rows[0].archived_at).toBeNull();
	});

	it('accepts archival stamps and nulls archived_by when the member is deleted', async () => {
		await h.db.query(
			`UPDATE documents SET archived_at = now(), archived_by_member_id = $1 WHERE id = $2`,
			[memberId, docId],
		);
		await h.db.query(
			`UPDATE assets SET archived_at = now(), archived_by_member_id = $1 WHERE id = $2`,
			[memberId, assetId],
		);

		await h.db.query(`DELETE FROM members WHERE id = $1`, [memberId]);

		const doc = await h.db.query<{
			archived_at: string | null;
			archived_by_member_id: string | null;
		}>(`SELECT archived_at, archived_by_member_id FROM documents WHERE id = $1`, [docId]);
		expect(doc.rows[0].archived_at).not.toBeNull();
		expect(doc.rows[0].archived_by_member_id).toBeNull();

		const asset = await h.db.query<{
			archived_at: string | null;
			archived_by_member_id: string | null;
		}>(`SELECT archived_at, archived_by_member_id FROM assets WHERE id = $1`, [assetId]);
		expect(asset.rows[0].archived_at).not.toBeNull();
		expect(asset.rows[0].archived_by_member_id).toBeNull();
	});
});
