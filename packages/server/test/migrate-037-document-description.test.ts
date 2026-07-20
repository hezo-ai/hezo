import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '037_document_description.sql';

describe('037_document_description migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	let docId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 036

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
		docId = doc.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds a NOT NULL description column defaulting to empty', async () => {
		const cols = await h.db.query<{
			column_name: string;
			is_nullable: string;
			column_default: string | null;
		}>(
			`SELECT column_name, is_nullable, column_default FROM information_schema.columns
			 WHERE table_name = 'documents' AND column_name = 'description'`,
		);
		expect(cols.rows).toHaveLength(1);
		expect(cols.rows[0].is_nullable).toBe('NO');
		expect(cols.rows[0].column_default).toMatch(/''::text/);
	});

	it('preserves pre-existing rows and backfills description to empty', async () => {
		const doc = await h.db.query<{ content: string; description: string }>(
			`SELECT content, description FROM documents WHERE id = $1`,
			[docId],
		);
		expect(doc.rows[0].content).toBe('# Spec');
		expect(doc.rows[0].description).toBe('');
	});

	it('accepts a description on subsequent writes', async () => {
		await h.db.query(`UPDATE documents SET description = $1 WHERE id = $2`, [
			'How the team tracks weekly analytics.',
			docId,
		]);
		const doc = await h.db.query<{ description: string }>(
			`SELECT description FROM documents WHERE id = $1`,
			[docId],
		);
		expect(doc.rows[0].description).toBe('How the team tracks weekly analytics.');
	});
});
