import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '002_project_icons.sql';

describe('002_project_icons migration', () => {
	let h: DataPreservationHarness;
	let projectId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Acme Project', 'acme-project', 'AP') RETURNING id`,
			[team.rows[0].id],
		);
		projectId = project.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the project_icons table with the icon columns', async () => {
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'project_icons'`,
		);
		const names = cols.rows.map((r) => r.column_name).sort();
		expect(names).toEqual(
			['byte_size', 'content_type', 'data', 'height', 'project_id', 'updated_at', 'width'].sort(),
		);
	});

	it('preserves pre-existing project rows', async () => {
		const kept = await h.db.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
		expect(kept.rows.length).toBe(1);
	});

	it('stores and reads back icon bytes 1:1 with a project', async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
		await h.db.query(
			`INSERT INTO project_icons (project_id, content_type, data, byte_size, width, height)
			 VALUES ($1, 'image/png', $2, $3, 512, 512)`,
			[projectId, bytes, bytes.byteLength],
		);
		const r = await h.db.query<{ data: Uint8Array; content_type: string }>(
			`SELECT data, content_type FROM project_icons WHERE project_id = $1`,
			[projectId],
		);
		expect(r.rows[0].content_type).toBe('image/png');
		expect(Buffer.from(r.rows[0].data).equals(bytes)).toBe(true);
	});

	it('cascades icon deletion when the project is removed', async () => {
		await h.db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
		const r = await h.db.query(`SELECT 1 FROM project_icons WHERE project_id = $1`, [projectId]);
		expect(r.rows.length).toBe(0);
	});
});
