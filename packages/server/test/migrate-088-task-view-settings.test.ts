import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '088_task_view_settings.sql';

/**
 * The migration adds a table beside `tasks` for each task's saved card state.
 * Existing tasks must come through untouched - including `updated_at`, which
 * list order and the Captain and Coach sweeps read as activity - and show the
 * defaults until someone toggles a card.
 */
describe('088_task_view_settings migration', () => {
	let h: DataPreservationHarness;
	let taskId: string;
	let updatedAtBefore: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id`,
			['team-view-settings'],
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, $2, $2, $3) RETURNING id`,
			[team.rows[0].id, 'view-settings', 'TVS'],
		);
		const task = await h.db.query<{ id: string; updated_at: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, rules, progress_summary)
			 VALUES ($1, $2, 1, 'TVS-1', 'Fold my cards', 'Run the suite', 'Half done')
			 RETURNING id, updated_at::text AS updated_at`,
			[team.rows[0].id, project.rows[0].id],
		);
		taskId = task.rows[0].id;
		updatedAtBefore = task.rows[0].updated_at;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('preserves existing tasks, their fields and their updated_at', async () => {
		const rows = await h.db.query<{
			identifier: string;
			title: string;
			rules: string;
			progress_summary: string;
			updated_at: string;
		}>(
			`SELECT identifier, title, rules, progress_summary, updated_at::text AS updated_at
			   FROM tasks WHERE id = $1`,
			[taskId],
		);
		expect(rows.rows).toEqual([
			{
				identifier: 'TVS-1',
				title: 'Fold my cards',
				rules: 'Run the suite',
				progress_summary: 'Half done',
				updated_at: updatedAtBefore,
			},
		]);
	});

	it('creates no settings row for an existing task, so it shows the defaults', async () => {
		const rows = await h.db.query(`SELECT 1 FROM task_view_settings WHERE task_id = $1`, [taskId]);
		expect(rows.rows).toHaveLength(0);
	});

	it('stores a task card state and defaults it to an empty map', async () => {
		await h.db.query(`INSERT INTO task_view_settings (task_id) VALUES ($1)`, [taskId]);
		await h.db.query(
			`UPDATE task_view_settings SET sections_open = sections_open || $2::jsonb WHERE task_id = $1`,
			[taskId, JSON.stringify({ sub_tasks: false })],
		);
		const rows = await h.db.query<{ sections_open: Record<string, boolean> }>(
			`SELECT sections_open FROM task_view_settings WHERE task_id = $1`,
			[taskId],
		);
		expect(rows.rows[0].sections_open).toEqual({ sub_tasks: false });

		const task = await h.db.query<{ updated_at: string }>(
			`SELECT updated_at::text AS updated_at FROM tasks WHERE id = $1`,
			[taskId],
		);
		expect(task.rows[0].updated_at).toBe(updatedAtBefore);
	});

	it('removes the settings row with its task', async () => {
		await h.db.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
		const rows = await h.db.query(`SELECT 1 FROM task_view_settings WHERE task_id = $1`, [taskId]);
		expect(rows.rows).toHaveLength(0);
	});
});
