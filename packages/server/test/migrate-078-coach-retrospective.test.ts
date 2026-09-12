import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '078_coach_retrospective.sql';

describe('078_coach_retrospective migration', () => {
	let h: DataPreservationHarness;
	let taskRunId: string;
	let progressRunId: string;
	let assetId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 078

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Acme', 'acme', 'AC') RETURNING id`,
			[teamId],
		);
		const projectId = project.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Coach') RETURNING id`,
			[teamId],
		);
		const memberId = member.rows[0].id;

		// One of each existing kind, so widening the enum is shown not to disturb
		// the rows already stored on it.
		const taskRun = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, kind, input_tokens)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, 'task'::heartbeat_run_kind, 1000)
			 RETURNING id`,
			[teamId, memberId],
		);
		taskRunId = taskRun.rows[0].id;
		const progressRun = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, kind)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status,
			         'progress_update'::heartbeat_run_kind)
			 RETURNING id`,
			[teamId, memberId],
		);
		progressRunId = progressRun.rows[0].id;

		const asset = await h.db.query<{ id: string }>(
			`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
			 VALUES ($1, $2, 'text/markdown', 4096, repeat('a', 64), 'report.md') RETURNING id`,
			[teamId, projectId],
		);
		assetId = asset.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('keeps the runs already stored on the kind it widens', async () => {
		const rows = await h.db.query<{ id: string; kind: string; input_tokens: string }>(
			`SELECT id, kind::text AS kind, input_tokens FROM heartbeat_runs
			 WHERE id = ANY($1::uuid[]) ORDER BY kind`,
			[[taskRunId, progressRunId]],
		);
		expect(rows.rows.map((r) => r.kind)).toEqual(['progress_update', 'task']);
		expect(Number(rows.rows[1].input_tokens)).toBe(1000);
	});

	it('keeps every pre-existing asset', async () => {
		const row = await h.db.query<{ byte_size: number; original_filename: string }>(
			`SELECT byte_size, original_filename FROM assets WHERE id = $1`,
			[assetId],
		);
		expect(Number(row.rows[0].byte_size)).toBe(4096);
		expect(row.rows[0].original_filename).toBe('report.md');
	});

	it('admits the new kind, which is the change taking effect', async () => {
		const values = await h.db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'heartbeat_run_kind'`,
		);
		expect(values.rows.map((r) => r.enumlabel)).toContain('retrospective');

		// And a row can actually be stored on it - the enum existing is not the same
		// as it being usable, which is the trap ADD VALUE sets inside a transaction.
		await expect(
			h.db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, status, kind)
				 SELECT team_id, member_id, 'succeeded'::heartbeat_run_status,
				        'retrospective'::heartbeat_run_kind
				   FROM heartbeat_runs WHERE id = $1`,
				[taskRunId],
			),
		).resolves.toBeDefined();
	});

	it('indexes every read this change adds', async () => {
		const idx = await h.db.query<{ indexname: string; tablename: string }>(
			`SELECT indexname, tablename FROM pg_indexes
			 WHERE tablename IN ('heartbeat_runs', 'assets', 'tasks')`,
		);
		const names = idx.rows.map((r) => r.indexname);
		expect(names).toContain('idx_runs_team_kind_started');
		expect(names).toContain('idx_assets_project_created');
		expect(names).toContain('idx_tasks_status_updated');
	});
});
