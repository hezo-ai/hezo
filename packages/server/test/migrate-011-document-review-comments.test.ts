import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '011_document_review_comments.sql';

describe('011_document_review_comments migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	let documentId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 010

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

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the document_review_comments table with its updated_at trigger', async () => {
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'document_review_comments' ORDER BY column_name`,
		);
		expect(cols.rows.map((r) => r.column_name)).toEqual([
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

		const trigger = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.triggers
			 WHERE event_object_table = 'document_review_comments'
			   AND trigger_name = 'trg_document_review_comments_updated'`,
		);
		expect(trigger.rows[0].c).toBeGreaterThan(0);
	});

	it('accepts rows and cascades on document delete', async () => {
		const inserted = await h.db.query<{ id: string }>(
			`INSERT INTO document_review_comments (document_id, quote, occurrence, comment, doc_updated_at)
			 SELECT id, 'Spec', 0, 'Expand this heading', updated_at FROM documents WHERE id = $1
			 RETURNING id`,
			[documentId],
		);
		expect(inserted.rows.length).toBe(1);

		const scratch = await h.db.query<{ id: string; updated_at: string }>(
			`INSERT INTO documents (team_id, project_id, type, slug, content)
			 VALUES ($1, $2, 'project_doc', 'scratch.md', 'x') RETURNING id, updated_at`,
			[teamId, projectId],
		);
		await h.db.query(
			`INSERT INTO document_review_comments (document_id, quote, occurrence, comment, doc_updated_at)
			 VALUES ($1, 'x', 0, 'temp', $2)`,
			[scratch.rows[0].id, scratch.rows[0].updated_at],
		);
		await h.db.query(`DELETE FROM documents WHERE id = $1`, [scratch.rows[0].id]);
		const orphans = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM document_review_comments WHERE document_id = $1`,
			[scratch.rows[0].id],
		);
		expect(orphans.rows[0].c).toBe(0);
	});

	it('preserves pre-existing rows', async () => {
		const team = await h.db.query(`SELECT 1 FROM teams WHERE id = $1`, [teamId]);
		expect(team.rows.length).toBe(1);
		const doc = await h.db.query<{ content: string }>(
			`SELECT content FROM documents WHERE id = $1`,
			[documentId],
		);
		expect(doc.rows[0].content).toBe('# Spec');
	});
});
