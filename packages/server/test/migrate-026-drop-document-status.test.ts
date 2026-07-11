import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '026_drop_document_status.sql';

describe('026_drop_document_status migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	let projectDocId: string;
	let preferencesDocId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 025 (status column still present)

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
		// Seed a doc carrying a non-default status so we prove the row survives
		// the column drop (not just that the schema changed).
		const projectDoc = await h.db.query<{ id: string }>(
			`INSERT INTO documents (team_id, project_id, type, slug, content, status)
			 VALUES ($1, $2, 'project_doc', 'spec.md', '# Spec', 'approved') RETURNING id`,
			[teamId, projectId],
		);
		projectDocId = projectDoc.rows[0].id;
		const preferencesDoc = await h.db.query<{ id: string }>(
			`INSERT INTO documents (team_id, type, slug, content)
			 VALUES ($1, 'team_preferences', 'preferences', 'Prefer TypeScript') RETURNING id`,
			[teamId],
		);
		preferencesDocId = preferencesDoc.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('drops the status column and the document_status enum type', async () => {
		const col = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.columns
			 WHERE table_name = 'documents' AND column_name = 'status'`,
		);
		expect(col.rows[0].c).toBe(0);

		const type = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM pg_type WHERE typname = 'document_status'`,
		);
		expect(type.rows[0].c).toBe(0);
	});

	it('preserves pre-existing document rows and their content', async () => {
		const projectDoc = await h.db.query<{ slug: string; content: string }>(
			`SELECT slug, content FROM documents WHERE id = $1`,
			[projectDocId],
		);
		expect(projectDoc.rows.length).toBe(1);
		expect(projectDoc.rows[0].slug).toBe('spec.md');
		expect(projectDoc.rows[0].content).toBe('# Spec');

		const preferencesDoc = await h.db.query<{ content: string }>(
			`SELECT content FROM documents WHERE id = $1`,
			[preferencesDocId],
		);
		expect(preferencesDoc.rows.length).toBe(1);
		expect(preferencesDoc.rows[0].content).toBe('Prefer TypeScript');
	});
});
