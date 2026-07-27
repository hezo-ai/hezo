import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '043_repos_push_access.sql';

describe('043_repos_push_access migration', () => {
	let h: DataPreservationHarness;
	let designatedRepoId: string;
	let secondRepoId: string;
	let projectId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 043

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Acme', 'acme', 'AC') RETURNING id`,
			[team.rows[0].id],
		);
		projectId = project.rows[0].id;

		// Two linked repos, mirroring the shape that motivated the column: a
		// designated one plus a second repo linked to the same project.
		const insertRepo = async (identifier: string): Promise<string> => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO repos (project_id, repo_identifier, host_type)
				 VALUES ($1, $2, 'github'::repo_host_type) RETURNING id`,
				[projectId, identifier],
			);
			return r.rows[0].id;
		};
		designatedRepoId = await insertRepo('hezo-ai/website');
		secondRepoId = await insertRepo('hezo-ai/hezo');
		await h.db.query(`UPDATE projects SET designated_repo_id = $1 WHERE id = $2`, [
			designatedRepoId,
			projectId,
		]);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds a nullable boolean can_push column to repos', async () => {
		const cols = await h.db.query<{ is_nullable: string; data_type: string }>(
			`SELECT is_nullable, data_type FROM information_schema.columns
			 WHERE table_name = 'repos' AND column_name = 'can_push'`,
		);
		expect(cols.rows.length).toBe(1);
		expect(cols.rows[0].is_nullable).toBe('YES');
		expect(cols.rows[0].data_type).toBe('boolean');
	});

	it('preserves pre-existing repos, their designation, and their project link', async () => {
		const kept = await h.db.query<{
			id: string;
			repo_identifier: string;
			project_id: string;
			can_push: boolean | null;
		}>(
			`SELECT id, repo_identifier, project_id, can_push FROM repos
			 WHERE id = ANY($1::uuid[]) ORDER BY repo_identifier`,
			[[designatedRepoId, secondRepoId]],
		);
		expect(kept.rows.map((r) => r.repo_identifier)).toEqual(['hezo-ai/hezo', 'hezo-ai/website']);
		expect(kept.rows.every((r) => r.project_id === projectId)).toBe(true);

		const designation = await h.db.query<{ designated_repo_id: string | null }>(
			`SELECT designated_repo_id FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(designation.rows[0].designated_repo_id).toBe(designatedRepoId);
	});

	it('leaves rows that pre-date the column as unknown rather than assuming write access', async () => {
		const rows = await h.db.query<{ can_push: boolean | null }>(
			`SELECT can_push FROM repos WHERE id = ANY($1::uuid[])`,
			[[designatedRepoId, secondRepoId]],
		);
		expect(rows.rows.map((r) => r.can_push)).toEqual([null, null]);
	});
});
