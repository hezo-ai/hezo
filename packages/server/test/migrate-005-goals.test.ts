import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '005_goals.sql';

describe('005_goals migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	let taskId: string;
	let runId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Acme Project', 'acme-project', 'AP') RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Captain') RETURNING id`,
			[teamId],
		);
		const memberId = member.rows[0].id;
		// A pre-existing task and heartbeat_run that must survive and pick up the new columns.
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, 1, 'AP-1', 'Existing task', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, projectId],
		);
		taskId = task.rows[0].id;
		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status) RETURNING id`,
			[teamId, memberId, taskId],
		);
		runId = run.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the goals and goal_run_updates tables and new enums', async () => {
		const tables = await h.db.query<{ table_name: string }>(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_name IN ('goals', 'goal_run_updates')`,
		);
		expect(tables.rows.map((r) => r.table_name).sort()).toEqual(['goal_run_updates', 'goals']);

		const enums = await h.db.query<{ typname: string }>(
			`SELECT typname FROM pg_type
			 WHERE typname IN ('goal_check_frequency', 'goal_health', 'heartbeat_run_kind')`,
		);
		expect(enums.rows.map((r) => r.typname).sort()).toEqual([
			'goal_check_frequency',
			'goal_health',
			'heartbeat_run_kind',
		]);
	});

	it('defaults existing heartbeat_runs to kind=task and tasks to goal_id NULL', async () => {
		const run = await h.db.query<{ kind: string }>(
			`SELECT kind::text AS kind FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		expect(run.rows[0].kind).toBe('task');
		const task = await h.db.query<{ goal_id: string | null }>(
			`SELECT goal_id FROM tasks WHERE id = $1`,
			[taskId],
		);
		expect(task.rows[0].goal_id).toBeNull();
	});

	it('preserves the pre-existing team, project, task, and run rows', async () => {
		const kept = await h.db.query(
			`SELECT
			   (SELECT count(*) FROM teams WHERE id = $1) AS teams,
			   (SELECT count(*) FROM projects WHERE id = $2) AS projects,
			   (SELECT count(*) FROM tasks WHERE id = $3) AS tasks,
			   (SELECT count(*) FROM heartbeat_runs WHERE id = $4) AS runs`,
			[teamId, projectId, taskId, runId],
		);
		const r = kept.rows[0] as Record<string, string>;
		expect(Number(r.teams)).toBe(1);
		expect(Number(r.projects)).toBe(1);
		expect(Number(r.tasks)).toBe(1);
		expect(Number(r.runs)).toBe(1);
	});

	it('enforces the progress_percent CHECK on goals', async () => {
		await expect(
			h.db.query(
				`INSERT INTO goals (team_id, project_id, title, progress_percent)
				 VALUES ($1, $2, 'Bad', 101)`,
				[teamId, projectId],
			),
		).rejects.toThrow();
	});

	it('round-trips a goal and a goal_run_update snapshot', async () => {
		const goal = await h.db.query<{ id: string; health: string; check_frequency: string }>(
			`INSERT INTO goals (team_id, project_id, title, description, progress_percent, health, status_blurb, check_frequency)
			 VALUES ($1, $2, 'Ship v1', 'Launch the product', 40, 'on_track'::goal_health, 'Coming along', 'weekly'::goal_check_frequency)
			 RETURNING id, health::text AS health, check_frequency::text AS check_frequency`,
			[teamId, projectId],
		);
		expect(goal.rows[0].health).toBe('on_track');
		expect(goal.rows[0].check_frequency).toBe('weekly');

		const upd = await h.db.query<{ progress_percent: number }>(
			`INSERT INTO goal_run_updates (run_id, goal_id, progress_percent, health, status_blurb)
			 VALUES ($1, $2, 40, 'on_track'::goal_health, 'Coming along')
			 RETURNING progress_percent`,
			[runId, goal.rows[0].id],
		);
		expect(upd.rows[0].progress_percent).toBe(40);

		// A task can now be linked to the goal.
		await h.db.query(`UPDATE tasks SET goal_id = $1 WHERE id = $2`, [goal.rows[0].id, taskId]);
		const linked = await h.db.query<{ goal_id: string }>(
			`SELECT goal_id FROM tasks WHERE id = $1`,
			[taskId],
		);
		expect(linked.rows[0].goal_id).toBe(goal.rows[0].id);
	});
});
