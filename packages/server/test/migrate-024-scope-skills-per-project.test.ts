import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '024_scope_skills_per_project.sql';

/**
 * 024 scopes skills by project (mirrors 018 for connectors). Seed at 023 (skills
 * still instance-global, slug globally UNIQUE), then assert the migration
 * preserves the existing rows as global (project_id NULL) AND applies the scoping
 * (nullable project_id + the two partial unique indexes that let the same slug
 * exist once globally and once per project).
 */
describe('024_scope_skills_per_project migration', () => {
	let h: DataPreservationHarness;
	let projectId: string;
	let globalSkillId: string;

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
		projectId = project.rows[0].id;

		// A pre-existing (global) skill, authored while the catalog was instance-global.
		const skill = await h.db.query<{ id: string }>(
			`INSERT INTO skills (name, slug, description, content, content_hash)
			 VALUES ('Deploy', 'deploy', 'How to deploy', 'run the deploy', 'abc') RETURNING id`,
		);
		globalSkillId = skill.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the project_id column and the two partial unique indexes', async () => {
		const col = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.columns
			 WHERE table_name = 'skills' AND column_name = 'project_id'`,
		);
		expect(col.rows[0].c).toBe(1);

		const idx = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE tablename = 'skills'`,
		);
		const names = idx.rows.map((r) => r.indexname);
		expect(names).toContain('idx_skills_global_slug');
		expect(names).toContain('idx_skills_project_slug');
	});

	it('preserves the pre-existing skill as a global (project_id NULL) row', async () => {
		const kept = await h.db.query<{ project_id: string | null }>(
			`SELECT project_id FROM skills WHERE id = $1`,
			[globalSkillId],
		);
		expect(kept.rows.length).toBe(1);
		expect(kept.rows[0].project_id).toBeNull();
	});

	it('allows the same slug once globally and once per project (partitioned uniqueness)', async () => {
		// A project-scoped skill with the same slug as the surviving global one must
		// be insertable — the per-project partial index namespaces it separately.
		await h.db.query(
			`INSERT INTO skills (name, slug, description, content, content_hash, project_id)
			 VALUES ('Deploy (site)', 'deploy', 'site deploy', 'site steps', 'def', $1)`,
			[projectId],
		);
		const rows = await h.db.query<{ project_id: string | null }>(
			`SELECT project_id FROM skills WHERE slug = 'deploy' ORDER BY project_id NULLS FIRST`,
		);
		expect(rows.rows.length).toBe(2);

		// A second global 'deploy' must be rejected by the global partial unique index.
		await expect(
			h.db.query(
				`INSERT INTO skills (name, slug, content, content_hash)
				 VALUES ('Dup', 'deploy', 'x', 'x')`,
			),
		).rejects.toThrow();
	});
});
