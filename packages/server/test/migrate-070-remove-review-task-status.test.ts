import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '070_remove_review_task_status.sql';

describe('070_remove_review_task_status migration', () => {
	let h: DataPreservationHarness;
	let reviewTaskId: string;
	let inProgressTaskId: string;
	let backlogTaskId: string;
	let blockedTaskId: string;
	let doneTaskId: string;
	let cancelledTaskId: string;
	let historyCommentId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Acme Project', 'acme-project', 'AP') RETURNING id`,
			[teamId],
		);
		const projectId = project.rows[0].id;

		// One task per status: 'review' must be re-homed onto 'in_progress'; the other
		// five must survive untouched. `progress_summary` is seeded so the assertions
		// can prove the whole row survived the table rewrite, not just its status.
		const seed = async (status: string, n: number): Promise<string> => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority,
				                    labels, progress_summary)
				 VALUES ($1, $2, $3, $4, $5, $6::task_status, 'medium'::task_priority, '[]'::jsonb, $7)
				 RETURNING id`,
				[teamId, projectId, n, `AP-${n}`, `Task ${n}`, status, `summary ${n}`],
			);
			return r.rows[0].id;
		};
		reviewTaskId = await seed('review', 1);
		inProgressTaskId = await seed('in_progress', 2);
		backlogTaskId = await seed('backlog', 3);
		blockedTaskId = await seed('blocked', 4);
		doneTaskId = await seed('done', 5);
		cancelledTaskId = await seed('cancelled', 6);

		// A historical status_change system comment naming 'review'. It is jsonb text,
		// not the enum, so it survives the type swap verbatim and the task thread keeps
		// rendering the transition that actually happened.
		const comment = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'system'::comment_content_type, $2::jsonb)
			 RETURNING id`,
			[doneTaskId, JSON.stringify({ kind: 'status_change', from: 'review', to: 'done' })],
		);
		historyCommentId = comment.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('re-homes the formerly-review task onto in_progress', async () => {
		const r = await h.db.query<{ status: string }>(
			`SELECT status::text AS status FROM tasks WHERE id = $1`,
			[reviewTaskId],
		);
		expect(r.rows[0].status).toBe('in_progress');
	});

	it('preserves every other task unchanged, non-status columns included', async () => {
		const rows = await h.db.query<{
			id: string;
			status: string;
			identifier: string;
			progress_summary: string;
		}>(
			`SELECT id, status::text AS status, identifier, progress_summary
			 FROM tasks WHERE id = ANY($1)`,
			[[inProgressTaskId, backlogTaskId, blockedTaskId, doneTaskId, cancelledTaskId]],
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r]));
		expect(byId.get(inProgressTaskId)?.status).toBe('in_progress');
		expect(byId.get(backlogTaskId)?.status).toBe('backlog');
		expect(byId.get(blockedTaskId)?.status).toBe('blocked');
		expect(byId.get(doneTaskId)?.status).toBe('done');
		expect(byId.get(cancelledTaskId)?.status).toBe('cancelled');
		// The ALTER rewrote the whole table, so assert the rest of the row came with it.
		expect(byId.get(backlogTaskId)?.identifier).toBe('AP-3');
		expect(byId.get(backlogTaskId)?.progress_summary).toBe('summary 3');
		expect(byId.get(cancelledTaskId)?.progress_summary).toBe('summary 6');
	});

	it('drops review from the task_status enum', async () => {
		const r = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel FROM pg_enum e
			 JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'task_status'
			 ORDER BY e.enumsortorder`,
		);
		const labels = r.rows.map((row) => row.enumlabel);
		expect(labels).toEqual(['backlog', 'in_progress', 'blocked', 'done', 'cancelled']);
		expect(labels).not.toContain('review');
	});

	it('keeps backlog as the column default', async () => {
		const col = await h.db.query<{ column_default: string | null }>(
			`SELECT column_default FROM information_schema.columns
			 WHERE table_name = 'tasks' AND column_name = 'status'`,
		);
		expect(col.rows[0].column_default).toMatch(/backlog/);
	});

	it('rebuilds every index on tasks.status, predicates included', async () => {
		const idx = await h.db.query<{ indexname: string; indexdef: string }>(
			`SELECT indexname, indexdef FROM pg_indexes
			 WHERE tablename = 'tasks'
			   AND indexname IN ('idx_tasks_status', 'idx_tasks_project_open_updated',
			                     'idx_tasks_project_done_updated')`,
		);
		const byName = new Map(idx.rows.map((r) => [r.indexname, r.indexdef]));
		expect(byName.size).toBe(3);
		// The two partials from 049 name enum literals in their predicates, which the
		// type swap has to reparse. This is the assertion that catches a broken swap.
		expect(byName.get('idx_tasks_project_open_updated')).toMatch(/done/);
		expect(byName.get('idx_tasks_project_done_updated')).toMatch(/done/);
	});

	it('leaves historical review status_change comments readable', async () => {
		const r = await h.db.query<{ from_status: string }>(
			`SELECT content->>'from' AS from_status FROM task_comments WHERE id = $1`,
			[historyCommentId],
		);
		expect(r.rows[0].from_status).toBe('review');
	});
});
