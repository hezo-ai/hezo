import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '009_rename_progress_update_kind.sql';

describe('009_rename_progress_update_kind migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let goalCheckRunId: string;
	let taskRunId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 008 — heartbeat_run_kind still has 'goal_check'

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Captain') RETURNING id`,
			[teamId],
		);
		const memberId = member.rows[0].id;

		// A pre-existing goal-check run (no task) that must survive and pick up the renamed value...
		const goalCheckRun = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, kind)
			 VALUES ($1, $2, NULL, 'succeeded'::heartbeat_run_status, 'goal_check'::heartbeat_run_kind)
			 RETURNING id`,
			[teamId, memberId],
		);
		goalCheckRunId = goalCheckRun.rows[0].id;
		// ...and a normal task-kind run that must be left untouched.
		const taskRun = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, kind)
			 VALUES ($1, $2, NULL, 'succeeded'::heartbeat_run_status, 'task'::heartbeat_run_kind)
			 RETURNING id`,
			[teamId, memberId],
		);
		taskRunId = taskRun.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('renames the enum value goal_check -> progress_update (task kept)', async () => {
		const labels = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel FROM pg_enum e
			 JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'heartbeat_run_kind'
			 ORDER BY e.enumsortorder`,
		);
		const values = labels.rows.map((r) => r.enumlabel);
		expect(values).toContain('progress_update');
		expect(values).toContain('task');
		expect(values).not.toContain('goal_check');
	});

	it('carries the pre-existing goal-check run forward as progress_update', async () => {
		const run = await h.db.query<{ kind: string }>(
			`SELECT kind::text AS kind FROM heartbeat_runs WHERE id = $1`,
			[goalCheckRunId],
		);
		expect(run.rows.length).toBe(1);
		expect(run.rows[0].kind).toBe('progress_update');
	});

	it('leaves task-kind runs and the team row untouched', async () => {
		const run = await h.db.query<{ kind: string }>(
			`SELECT kind::text AS kind FROM heartbeat_runs WHERE id = $1`,
			[taskRunId],
		);
		expect(run.rows[0].kind).toBe('task');
		const team = await h.db.query(`SELECT 1 FROM teams WHERE id = $1`, [teamId]);
		expect(team.rows.length).toBe(1);
	});
});
