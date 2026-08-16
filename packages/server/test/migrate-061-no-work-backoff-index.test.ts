import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '061_no_work_backoff_index.sql';

describe('061_no_work_backoff_index migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let memberId: string;
	let taskId: string;
	let noWorkRunId: string;
	let workingRunId: string;
	let otherTaskRunId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 061

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Acme', 'acme', 'AC') RETURNING id`,
			[teamId],
		);
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Worker') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'AC-1', 'Daily check') RETURNING id`,
			[teamId, project.rows[0].id],
		);
		taskId = task.rows[0].id;
		const otherTask = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 2, 'AC-2', 'Something else') RETURNING id`,
			[teamId, project.rows[0].id],
		);

		// An older no-work run and a newer working one on the SAME task: the query
		// this index serves must return the newer, so a pair is the minimum that
		// proves it orders rather than merely filters.
		const noWork = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at, reported_no_work)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status,
			         TIMESTAMPTZ '2026-01-02 09:00:00Z', TIMESTAMPTZ '2026-01-02 09:05:00Z', true)
			 RETURNING id`,
			[teamId, memberId, taskId],
		);
		noWorkRunId = noWork.rows[0].id;
		const working = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at, reported_no_work)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status,
			         TIMESTAMPTZ '2026-01-02 11:00:00Z', TIMESTAMPTZ '2026-01-02 11:20:00Z', false)
			 RETURNING id`,
			[teamId, memberId, taskId],
		);
		workingRunId = working.rows[0].id;
		// A newer run on a DIFFERENT task. Without the task column in the key this
		// is the row a (member_id, finished_at DESC) walk reaches first.
		const otherRun = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at, reported_no_work)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status,
			         TIMESTAMPTZ '2026-01-02 12:00:00Z', TIMESTAMPTZ '2026-01-02 12:10:00Z', true)
			 RETURNING id`,
			[teamId, memberId, otherTask.rows[0].id],
		);
		otherTaskRunId = otherRun.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the member/task/finished index', async () => {
		const r = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_runs_member_task_finished'`,
		);
		expect(r.rows.length).toBe(1);
		const def = r.rows[0].indexdef.toLowerCase();
		expect(def).toContain('member_id');
		expect(def).toContain('task_id');
		expect(def).toContain('finished_at');
		// Partial would silently exclude runs the backoff has to reason about.
		expect(def).not.toContain('where');
	});

	it('preserves every pre-existing run row and its no-work verdict', async () => {
		const kept = await h.db.query<{ id: string; reported_no_work: boolean }>(
			`SELECT id, reported_no_work FROM heartbeat_runs WHERE team_id = $1 ORDER BY finished_at`,
			[teamId],
		);
		expect(kept.rows.length).toBe(3);
		expect(kept.rows.map((r) => r.id)).toEqual([noWorkRunId, workingRunId, otherTaskRunId]);
		expect(kept.rows.map((r) => r.reported_no_work)).toEqual([true, false, true]);
	});

	it('serves the backoff lookup the index was added for, scoped to one task', async () => {
		const r = await h.db.query<{ id: string; reported_no_work: boolean }>(
			`SELECT hr.id, hr.reported_no_work
			 FROM heartbeat_runs hr
			 WHERE hr.member_id = $1 AND hr.task_id = $2 AND hr.finished_at IS NOT NULL
			 ORDER BY hr.finished_at DESC
			 LIMIT 1`,
			[memberId, taskId],
		);
		expect(r.rows.length).toBe(1);
		// The newer run on this task, not the newer run on the other one.
		expect(r.rows[0].id).toBe(workingRunId);
		expect(r.rows[0].reported_no_work).toBe(false);
	});
});
