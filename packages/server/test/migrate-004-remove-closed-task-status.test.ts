import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '004_remove_closed_task_status.sql';

describe('004_remove_closed_task_status migration', () => {
	let h: DataPreservationHarness;
	let closedTaskId: string;
	let doneTaskId: string;
	let backlogTaskId: string;
	let cancelledTaskId: string;

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
		const teamId = team.rows[0].id;
		const projectId = project.rows[0].id;

		// Seed one task per status that exercises the migration: a 'closed' task
		// that must be re-homed onto 'done', plus 'done'/'backlog'/'cancelled' that
		// must survive untouched.
		const seed = async (status: string, n: number): Promise<string> => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
				 VALUES ($1, $2, $3, $4, $5, $6::task_status, 'medium'::task_priority, '[]'::jsonb)
				 RETURNING id`,
				[teamId, projectId, n, `AP-${n}`, `Task ${n}`, status],
			);
			return r.rows[0].id;
		};
		closedTaskId = await seed('closed', 1);
		doneTaskId = await seed('done', 2);
		backlogTaskId = await seed('backlog', 3);
		cancelledTaskId = await seed('cancelled', 4);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('re-homes the formerly-closed task onto done', async () => {
		const r = await h.db.query<{ status: string }>(
			`SELECT status::text AS status FROM tasks WHERE id = $1`,
			[closedTaskId],
		);
		expect(r.rows[0].status).toBe('done');
	});

	it('preserves done, backlog, and cancelled tasks unchanged', async () => {
		const rows = await h.db.query<{ id: string; status: string }>(
			`SELECT id, status::text AS status FROM tasks WHERE id = ANY($1)`,
			[[doneTaskId, backlogTaskId, cancelledTaskId]],
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
		expect(byId.get(doneTaskId)).toBe('done');
		expect(byId.get(backlogTaskId)).toBe('backlog');
		expect(byId.get(cancelledTaskId)).toBe('cancelled');
	});

	it('drops closed from the task_status enum', async () => {
		const r = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel FROM pg_enum e
			 JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'task_status'
			 ORDER BY e.enumsortorder`,
		);
		const labels = r.rows.map((row) => row.enumlabel);
		expect(labels).toEqual(['backlog', 'in_progress', 'review', 'blocked', 'done', 'cancelled']);
		expect(labels).not.toContain('closed');
	});

	it('keeps backlog as the column default', async () => {
		const col = await h.db.query<{ column_default: string | null }>(
			`SELECT column_default FROM information_schema.columns
			 WHERE table_name = 'tasks' AND column_name = 'status'`,
		);
		expect(col.rows[0].column_default).toMatch(/backlog/);
	});

	it('rebuilds the status index', async () => {
		const idx = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE tablename = 'tasks' AND indexname = 'idx_tasks_status'`,
		);
		expect(idx.rows.length).toBe(1);
	});
});
