import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '049_progress_activity.sql';

const EXPECTED_INDEXES = [
	'idx_tasks_project_open_updated',
	'idx_tasks_project_done_updated',
	'idx_tasks_project_created',
	'idx_runs_team_started_task',
];

describe('049_progress_activity migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	let openTaskId: string;
	let doneTaskId: string;
	let cancelledTaskId: string;
	let taskRunId: string;
	let progressRunId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 049

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		// A project carrying a summary written before the migration — the thing
		// that must survive, since the new column lands on this very row.
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, progress_summary, progress_summary_updated_at)
			 VALUES ($1, 'Acme', 'acme', 'AC', 'Pre-existing summary.', now()) RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Captain') RETURNING id`,
			[teamId],
		);
		const memberId = member.rows[0].id;

		// One task per status class the candidate windows discriminate on.
		const seedTask = async (n: number, status: string) => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title, status)
				 VALUES ($1, $2, $3, $4, $5, $6::task_status) RETURNING id`,
				[teamId, projectId, n, `AC-${n}`, `Task ${n}`, status],
			);
			return r.rows[0].id;
		};
		openTaskId = await seedTask(1, 'in_progress');
		doneTaskId = await seedTask(2, 'done');
		cancelledTaskId = await seedTask(3, 'cancelled');

		// A task-scoped run and a progress-update run (no task_id) — the pair the
		// partial index on heartbeat_runs exists to tell apart.
		const taskRun = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, kind, status, started_at)
			 VALUES ($1, $2, $3, 'task'::heartbeat_run_kind, 'succeeded'::heartbeat_run_status, now())
			 RETURNING id`,
			[teamId, memberId, openTaskId],
		);
		taskRunId = taskRun.rows[0].id;
		const progressRun = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, kind, status, started_at)
			 VALUES ($1, $2, 'progress_update'::heartbeat_run_kind, 'succeeded'::heartbeat_run_status, now())
			 RETURNING id`,
			[teamId, memberId],
		);
		progressRunId = progressRun.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds progress_activity defaulting to an empty object on existing projects', async () => {
		const r = await h.db.query<{ progress_activity: unknown }>(
			`SELECT progress_activity FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(r.rows[0].progress_activity).toEqual({});
	});

	it('preserves the pre-existing progress summary on the row it altered', async () => {
		const r = await h.db.query<{ progress_summary: string; updated: string | null }>(
			`SELECT progress_summary, progress_summary_updated_at AS updated FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(r.rows[0].progress_summary).toBe('Pre-existing summary.');
		expect(r.rows[0].updated).not.toBeNull();
	});

	it('stores and reads back a full snapshot document', async () => {
		const snapshot = {
			actioned: [{ identifier: 'AC-1', title: 'Task 1', summary: 'Auth rewrite is nearly done.' }],
			created: [{ identifier: 'AC-3', title: 'Task 3', summary: 'Billing split, to de-risk it.' }],
			closed: [{ identifier: 'AC-2', title: 'Task 2', summary: 'Webhooks now verified.' }],
		};
		await h.db.query(`UPDATE projects SET progress_activity = $1::jsonb WHERE id = $2`, [
			JSON.stringify(snapshot),
			projectId,
		]);
		const r = await h.db.query<{ progress_activity: typeof snapshot }>(
			`SELECT progress_activity FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(r.rows[0].progress_activity).toEqual(snapshot);
	});

	it('creates every candidate-query index', async () => {
		const r = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[])`,
			[EXPECTED_INDEXES],
		);
		expect(r.rows.map((row) => row.indexname).sort()).toEqual([...EXPECTED_INDEXES].sort());
	});

	// The status predicates are the whole point of the two partial task indexes:
	// "actioned" is open work only, "closed" is `done` only — `cancelled` is
	// excluded from the candidate set entirely.
	it('keeps the task indexes partial to the exact status sets the columns use', async () => {
		const r = await h.db.query<{ indexname: string; indexdef: string }>(
			`SELECT indexname, indexdef FROM pg_indexes
			 WHERE indexname IN ('idx_tasks_project_open_updated', 'idx_tasks_project_done_updated')`,
		);
		const byName = Object.fromEntries(r.rows.map((row) => [row.indexname, row.indexdef]));
		expect(byName.idx_tasks_project_open_updated).toMatch(/WHERE.*done/is);
		expect(byName.idx_tasks_project_open_updated).toMatch(/cancelled/i);
		expect(byName.idx_tasks_project_done_updated).toMatch(/WHERE.*'done'/is);
		expect(byName.idx_tasks_project_done_updated).not.toMatch(/cancelled/i);
	});

	// Excluding NULL task_id is not just selectivity: it is exactly what keeps a
	// progress-update run (which carries no task) out of the "actioned" ranking,
	// so the summary can never report on its own runs.
	it('excludes taskless runs from the run index, which is how progress runs stay out of actioned', async () => {
		const r = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_runs_team_started_task'`,
		);
		expect(r.rows[0].indexdef).toMatch(/WHERE.*task_id IS NOT NULL/is);

		const candidates = await h.db.query<{ id: string }>(
			`SELECT id FROM heartbeat_runs
			 WHERE team_id = $1 AND task_id IS NOT NULL ORDER BY started_at DESC`,
			[teamId],
		);
		const ids = candidates.rows.map((row) => row.id);
		expect(ids).toContain(taskRunId);
		expect(ids).not.toContain(progressRunId);
	});

	it('preserves every pre-existing task', async () => {
		const kept = await h.db.query<{ id: string }>(
			`SELECT id FROM tasks WHERE id = ANY($1::uuid[])`,
			[[openTaskId, doneTaskId, cancelledTaskId]],
		);
		expect(kept.rows.length).toBe(3);
	});

	it('still serves the candidate windows the indexes were added for', async () => {
		const open = await h.db.query<{ id: string }>(
			`SELECT id FROM tasks WHERE project_id = $1 AND status NOT IN ('done','cancelled')
			 ORDER BY updated_at DESC LIMIT 25`,
			[projectId],
		);
		expect(open.rows.map((r) => r.id)).toEqual([openTaskId]);

		const done = await h.db.query<{ id: string }>(
			`SELECT id FROM tasks WHERE project_id = $1 AND status = 'done'
			 ORDER BY updated_at DESC LIMIT 50`,
			[projectId],
		);
		expect(done.rows.map((r) => r.id)).toEqual([doneTaskId]);

		const created = await h.db.query<{ id: string }>(
			`SELECT id FROM tasks WHERE project_id = $1 ORDER BY created_at DESC LIMIT 10`,
			[projectId],
		);
		expect(created.rows.length).toBe(3);
	});
});
