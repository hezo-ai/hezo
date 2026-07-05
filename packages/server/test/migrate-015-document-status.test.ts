import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '015_document_status.sql';

describe('015_document_status migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	let projectDocId: string;
	let preferencesDocId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 014

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
		const projectDoc = await h.db.query<{ id: string }>(
			`INSERT INTO documents (team_id, project_id, type, slug, content)
			 VALUES ($1, $2, 'project_doc', 'spec.md', '# Spec') RETURNING id`,
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

	it('adds the status column with the planning default', async () => {
		const col = await h.db.query<{ column_default: string; is_nullable: string }>(
			`SELECT column_default, is_nullable FROM information_schema.columns
			 WHERE table_name = 'documents' AND column_name = 'status'`,
		);
		expect(col.rows.length).toBe(1);
		expect(col.rows[0].is_nullable).toBe('NO');
		expect(col.rows[0].column_default).toContain('planning');

		const inserted = await h.db.query<{ status: string }>(
			`INSERT INTO documents (team_id, project_id, type, slug, content)
			 VALUES ($1, $2, 'project_doc', 'fresh.md', 'x') RETURNING status`,
			[teamId, projectId],
		);
		expect(inserted.rows[0].status).toBe('planning');

		const approved = await h.db.query<{ status: string }>(
			`INSERT INTO documents (team_id, project_id, type, slug, content, status)
			 VALUES ($1, $2, 'project_doc', 'approved.md', 'x', 'approved') RETURNING status`,
			[teamId, projectId],
		);
		expect(approved.rows[0].status).toBe('approved');

		await expect(
			h.db.query(
				`INSERT INTO documents (team_id, project_id, type, slug, content, status)
				 VALUES ($1, $2, 'project_doc', 'bogus.md', 'x', 'shipped')`,
				[teamId, projectId],
			),
		).rejects.toThrow(/invalid input value for enum document_status/);
	});

	it('preserves pre-existing rows and backfills them to planning', async () => {
		const projectDoc = await h.db.query<{ content: string; status: string }>(
			`SELECT content, status FROM documents WHERE id = $1`,
			[projectDocId],
		);
		expect(projectDoc.rows[0].content).toBe('# Spec');
		expect(projectDoc.rows[0].status).toBe('planning');

		const preferencesDoc = await h.db.query<{ content: string; status: string }>(
			`SELECT content, status FROM documents WHERE id = $1`,
			[preferencesDocId],
		);
		expect(preferencesDoc.rows[0].content).toBe('Prefer TypeScript');
		expect(preferencesDoc.rows[0].status).toBe('planning');
	});
});
