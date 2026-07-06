import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '017_repo_setup_status.sql';

describe('017_repo_setup_status migration', () => {
	let h: DataPreservationHarness;
	let seededRepoId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Site', 'site', 'SITE') RETURNING id`,
			[team.rows[0].id],
		);
		const repo = await h.db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'acme/site', 'github') RETURNING id`,
			[project.rows[0].id],
		);
		seededRepoId = repo.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the setup_status and setup_error columns', async () => {
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'repos' AND column_name IN ('setup_status', 'setup_error')`,
		);
		expect(cols.rows.map((r) => r.column_name).sort()).toEqual(['setup_error', 'setup_status']);
	});

	it('backfills pre-existing rows as ready with no error', async () => {
		const kept = await h.db.query<{
			repo_identifier: string;
			setup_status: string;
			setup_error: string | null;
		}>(`SELECT repo_identifier, setup_status, setup_error FROM repos WHERE id = $1`, [
			seededRepoId,
		]);
		expect(kept.rows).toHaveLength(1);
		expect(kept.rows[0].repo_identifier).toBe('acme/site');
		expect(kept.rows[0].setup_status).toBe('ready');
		expect(kept.rows[0].setup_error).toBeNull();
	});

	it('accepts the new lifecycle states on insert', async () => {
		const project = await h.db.query<{ id: string }>(`SELECT project_id AS id FROM repos LIMIT 1`);
		const inserted = await h.db.query<{ setup_status: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type, setup_status, setup_error)
			 VALUES ($1, 'acme/pending-repo', 'github', 'pending', NULL)
			 RETURNING setup_status`,
			[project.rows[0].id],
		);
		expect(inserted.rows[0].setup_status).toBe('pending');
	});
});
