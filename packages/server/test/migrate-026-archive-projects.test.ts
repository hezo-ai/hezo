import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '026_archive_projects.sql';

describe('026_archive_projects migration', () => {
	let h: DataPreservationHarness;
	let projectId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 026

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Demo', 'demo', 'DM') RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds a nullable archived_at column to projects', async () => {
		const cols = await h.db.query<{ column_name: string; is_nullable: string; data_type: string }>(
			`SELECT column_name, is_nullable, data_type FROM information_schema.columns
			 WHERE table_name = 'projects' AND column_name = 'archived_at'`,
		);
		expect(cols.rows.length).toBe(1);
		expect(cols.rows[0].is_nullable).toBe('YES');
		expect(cols.rows[0].data_type).toBe('timestamp with time zone');
	});

	it('preserves pre-existing projects as active (archived_at NULL)', async () => {
		const project = await h.db.query<{ name: string; archived_at: string | null }>(
			`SELECT name, archived_at FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(project.rows[0].name).toBe('Demo');
		expect(project.rows[0].archived_at).toBeNull();
	});

	it('accepts archival stamps and clears them on unarchive', async () => {
		await h.db.query(`UPDATE projects SET archived_at = now() WHERE id = $1`, [projectId]);
		const archived = await h.db.query<{ archived_at: string | null }>(
			`SELECT archived_at FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(archived.rows[0].archived_at).not.toBeNull();

		await h.db.query(`UPDATE projects SET archived_at = NULL WHERE id = $1`, [projectId]);
		const active = await h.db.query<{ archived_at: string | null }>(
			`SELECT archived_at FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(active.rows[0].archived_at).toBeNull();
	});
});
