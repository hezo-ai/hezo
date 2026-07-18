import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '035_comments_task_created_idx.sql';

describe('035_comments_task_created_idx migration', () => {
	let h: DataPreservationHarness;
	let taskId: string;
	const commentIds: string[] = [];

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at N-1

		// Seed a task with a few comments (representative feed data) at the prior schema.
		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Ops', 'ops', 'OPS') RETURNING id`,
			[team.rows[0].id],
		);
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'OPS-1', 'Seed task') RETURNING id`,
			[team.rows[0].id, project.rows[0].id],
		);
		taskId = task.rows[0].id;
		for (let i = 0; i < 3; i++) {
			const c = await h.db.query<{ id: string }>(
				`INSERT INTO task_comments (task_id, content_type, content)
				 VALUES ($1, 'text'::comment_content_type, $2::jsonb) RETURNING id`,
				[taskId, JSON.stringify({ text: `comment ${i}` })],
			);
			commentIds.push(c.rows[0].id);
		}

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the composite (task_id, created_at) index and drops the redundant task-only one', async () => {
		const composite = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM pg_indexes WHERE indexname = 'idx_comments_task_created'`,
		);
		expect(composite.rows[0].c).toBe(1);

		const old = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM pg_indexes WHERE indexname = 'idx_comments_task'`,
		);
		expect(old.rows[0].c).toBe(0);
	});

	it('preserves pre-existing comments and their ordering', async () => {
		const rows = await h.db.query<{ id: string }>(
			`SELECT id FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC`,
			[taskId],
		);
		expect(rows.rows.map((r) => r.id)).toEqual(commentIds);
	});
});
