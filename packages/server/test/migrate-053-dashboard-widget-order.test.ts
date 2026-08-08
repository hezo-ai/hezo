import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '053_dashboard_widget_order.sql';

describe('053_dashboard_widget_order migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 052

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('MigrateTest', 'migratetest') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Demo', 'demo-038', 'DX8') RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds dashboard_widget_order column', async () => {
		const cols = await h.db.query<{ column_name: string; is_nullable: string }>(
			`SELECT column_name, is_nullable FROM information_schema.columns
			 WHERE table_name = 'projects' AND column_name = 'dashboard_widget_order'`,
		);
		expect(cols.rows).toHaveLength(1);
		expect(cols.rows[0].is_nullable).toBe('YES');
	});

	it('preserves pre-existing project rows with NULL widget order', async () => {
		const row = await h.db.query<{ name: string; dashboard_widget_order: unknown }>(
			`SELECT name, dashboard_widget_order FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(row.rows).toHaveLength(1);
		expect(row.rows[0].name).toBe('Demo');
		expect(row.rows[0].dashboard_widget_order).toBeNull();
	});

	it('accepts a jsonb widget order on subsequent writes', async () => {
		const order = ['goals', 'team_snapshot', 'in_progress', 'spend'];
		await h.db.query(`UPDATE projects SET dashboard_widget_order = $1 WHERE id = $2`, [
			JSON.stringify(order),
			projectId,
		]);
		const row = await h.db.query<{ dashboard_widget_order: unknown }>(
			`SELECT dashboard_widget_order FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(row.rows[0].dashboard_widget_order).toEqual(order);
	});
});
