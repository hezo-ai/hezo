import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '060_agent_hours_index.sql';

describe('060_agent_hours_index migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let memberId: string;
	let taskRunId: string;
	let plainRunId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 060

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
			 VALUES ($1, $2, 1, 'AC-1', 'Seeded task') RETURNING id`,
			[teamId, project.rows[0].id],
		);

		// One task-scoped run and one without a task. The pair is the point: the
		// pre-existing 049 index is partial on `task_id IS NOT NULL`, so only the
		// first is reachable through it, while Hours must count both.
		const taskRun = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status,
			         TIMESTAMPTZ '2026-01-02 09:00:00Z', TIMESTAMPTZ '2026-01-02 09:30:00Z')
			 RETURNING id`,
			[teamId, memberId, task.rows[0].id],
		);
		taskRunId = taskRun.rows[0].id;
		const plainRun = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, started_at, finished_at)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status,
			         TIMESTAMPTZ '2026-01-02 11:00:00Z', TIMESTAMPTZ '2026-01-02 11:15:00Z')
			 RETURNING id`,
			[teamId, memberId],
		);
		plainRunId = plainRun.rows[0].id;

		// An unfinished run, which the tab must exclude rather than count as zero.
		await h.db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, started_at)
			 VALUES ($1, $2, 'running'::heartbeat_run_status, TIMESTAMPTZ '2026-01-02 12:00:00Z')`,
			[teamId, memberId],
		);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the unpartitioned team/started index', async () => {
		const r = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_runs_team_started'`,
		);
		expect(r.rows.length).toBe(1);
		const def = r.rows[0].indexdef.toLowerCase();
		expect(def).toContain('team_id');
		expect(def).toContain('started_at');
		// Partial would reintroduce exactly the gap this index exists to close.
		expect(def).not.toContain('where');
	});

	it('preserves every pre-existing run row', async () => {
		const kept = await h.db.query<{ id: string }>(
			`SELECT id FROM heartbeat_runs WHERE team_id = $1 ORDER BY started_at`,
			[teamId],
		);
		expect(kept.rows.length).toBe(3);
		expect(kept.rows.map((r) => r.id)).toContain(taskRunId);
		expect(kept.rows.map((r) => r.id)).toContain(plainRunId);
	});

	it('serves the hours query the index was added for, counting task-less runs', async () => {
		const r = await h.db.query<{ agent_id: string; seconds: number; run_count: number }>(
			`SELECT hr.member_id AS agent_id,
			        COALESCE(SUM(EXTRACT(EPOCH FROM (hr.finished_at - hr.started_at))), 0)::int AS seconds,
			        count(*)::int AS run_count
			 FROM heartbeat_runs hr
			 WHERE hr.team_id = $1
			   AND hr.started_at IS NOT NULL
			   AND hr.finished_at IS NOT NULL
			   AND hr.started_at >= TIMESTAMPTZ '2026-01-01 00:00:00Z'
			 GROUP BY hr.member_id`,
			[teamId],
		);
		expect(r.rows.length).toBe(1);
		expect(r.rows[0].agent_id).toBe(memberId);
		// 30 minutes + 15 minutes; the unfinished run contributes nothing.
		expect(r.rows[0].seconds).toBe(2700);
		expect(r.rows[0].run_count).toBe(2);
	});
});
