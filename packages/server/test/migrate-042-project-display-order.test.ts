import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '042_project_display_order.sql';

describe('042_project_display_order migration', () => {
	let h: DataPreservationHarness;
	// Seeded oldest → newest, so the rail's newest-first order is c, b, a.
	let oldestId: string;
	let middleId: string;
	let newestId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 042

		const seedProject = async (
			teamSlug: string,
			name: string,
			slug: string,
			prefix: string,
			createdAt: string,
		): Promise<string> => {
			const team = await h.db.query<{ id: string }>(
				`INSERT INTO teams (name, slug) VALUES ($1, $2) RETURNING id`,
				[name, teamSlug],
			);
			const project = await h.db.query<{ id: string }>(
				`INSERT INTO projects (team_id, name, slug, task_prefix, created_at)
				 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
				[team.rows[0].id, name, slug, prefix, createdAt],
			);
			return project.rows[0].id;
		};

		oldestId = await seedProject('acme', 'Acme', 'acme', 'AC', '2024-01-01T00:00:00Z');
		middleId = await seedProject('beta', 'Beta', 'beta', 'BT', '2024-02-01T00:00:00Z');
		newestId = await seedProject('gamma', 'Gamma', 'gamma', 'GA', '2024-03-01T00:00:00Z');

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds a NOT NULL integer display_order column to projects', async () => {
		const cols = await h.db.query<{ column_name: string; is_nullable: string; data_type: string }>(
			`SELECT column_name, is_nullable, data_type FROM information_schema.columns
			 WHERE table_name = 'projects' AND column_name = 'display_order'`,
		);
		expect(cols.rows.length).toBe(1);
		expect(cols.rows[0].is_nullable).toBe('NO');
		expect(cols.rows[0].data_type).toBe('integer');
	});

	it('preserves pre-existing projects', async () => {
		const kept = await h.db.query<{ id: string; name: string }>(
			`SELECT id, name FROM projects WHERE id = ANY($1::uuid[]) ORDER BY name`,
			[[oldestId, middleId, newestId]],
		);
		expect(kept.rows.map((r) => r.name)).toEqual(['Acme', 'Beta', 'Gamma']);
	});

	it('backfills positions in the rail order those projects rendered in before (newest first)', async () => {
		const ordered = await h.db.query<{ id: string; display_order: number }>(
			`SELECT id, display_order FROM projects ORDER BY display_order ASC`,
		);
		expect(ordered.rows.map((r) => r.id)).toEqual([newestId, middleId, oldestId]);
		// Dense from 1 — the reorder route renumbers back into this shape.
		expect(ordered.rows.map((r) => r.display_order)).toEqual([1, 2, 3]);
	});

	it('adds the partial index the active-rail listing orders on', async () => {
		const idx = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes
			 WHERE tablename = 'projects' AND indexname = 'idx_projects_display_order'`,
		);
		expect(idx.rows).toHaveLength(1);
	});

	it('accepts a renumbering reorder, including the negative values new projects get', async () => {
		await h.db.query(`UPDATE projects SET display_order = 1 WHERE id = $1`, [oldestId]);
		await h.db.query(`UPDATE projects SET display_order = 2 WHERE id = $1`, [newestId]);
		await h.db.query(`UPDATE projects SET display_order = 3 WHERE id = $1`, [middleId]);
		await h.db.query(`UPDATE projects SET display_order = -1 WHERE id = $1`, [middleId]);

		const ordered = await h.db.query<{ id: string }>(
			`SELECT id FROM projects ORDER BY display_order ASC, created_at DESC`,
		);
		expect(ordered.rows.map((r) => r.id)).toEqual([middleId, oldestId, newestId]);
	});
});
