import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '047_hot_path_indexes.sql';

const EXPECTED_INDEXES = [
	'idx_runs_member_finished',
	'idx_runs_member_started',
	'idx_runs_task_started',
	'idx_wakeups_pending',
	'idx_audit_created_id',
	'idx_audit_project_created_id',
	'idx_tasks_identifier_lower',
];

describe('047_hot_path_indexes migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let memberId: string;
	let taskId: string;
	let runId: string;
	let wakeupId: string;
	const auditIds: string[] = [];

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 047

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
		taskId = task.rows[0].id;

		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now(), now()) RETURNING id`,
			[teamId, memberId, taskId],
		);
		runId = run.rows[0].id;

		const wakeup = await h.db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
			 VALUES ($1, $2, 'timer'::wakeup_source, 'queued'::wakeup_status, '{}'::jsonb)
			 RETURNING id`,
			[memberId, teamId],
		);
		wakeupId = wakeup.rows[0].id;

		// Three audit rows sharing one timestamp - exactly the case the `id`
		// tiebreak exists for, and the one a created_at-only order gets wrong.
		for (let i = 0; i < 3; i++) {
			const row = await h.db.query<{ id: string }>(
				`INSERT INTO audit_log (project_id, actor_type, action, entity_type, details, created_at)
				 VALUES ($1, 'admin', 'update', 'task', '{}'::jsonb, TIMESTAMPTZ '2026-01-01 00:00:00Z')
				 RETURNING id`,
				[project.rows[0].id],
			);
			auditIds.push(row.rows[0].id);
		}

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates every hot-path index', async () => {
		const r = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[])`,
			[EXPECTED_INDEXES],
		);
		expect(r.rows.map((row) => row.indexname).sort()).toEqual([...EXPECTED_INDEXES].sort());
	});

	// The point of the identifier index is that it covers the LOWER() predicate
	// `resolveTaskId` actually issues — the pre-existing (team_id, identifier)
	// index cannot.
	it('indexes tasks on LOWER(identifier), which the plain identifier index cannot serve', async () => {
		const r = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_tasks_identifier_lower'`,
		);
		expect(r.rows[0].indexdef.toLowerCase()).toContain('lower(identifier)');

		// And the query it exists for still resolves the seeded task.
		const found = await h.db.query<{ id: string }>(
			`SELECT id FROM tasks WHERE team_id = $1 AND LOWER(identifier) = LOWER($2)`,
			[teamId, 'ac-1'],
		);
		expect(found.rows[0].id).toBe(taskId);
	});

	it('keeps the wakeup index partial to the live dispatch states', async () => {
		const r = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_wakeups_pending'`,
		);
		expect(r.rows[0].indexdef.toLowerCase()).toContain('where');
		expect(r.rows[0].indexdef).toContain('queued');
	});

	it('preserves pre-existing rows across every touched table', async () => {
		const run = await h.db.query(`SELECT 1 FROM heartbeat_runs WHERE id = $1`, [runId]);
		expect(run.rows.length).toBe(1);
		const wakeup = await h.db.query(`SELECT 1 FROM agent_wakeup_requests WHERE id = $1`, [
			wakeupId,
		]);
		expect(wakeup.rows.length).toBe(1);
		const task = await h.db.query<{ identifier: string }>(
			`SELECT identifier FROM tasks WHERE id = $1`,
			[taskId],
		);
		expect(task.rows[0].identifier).toBe('AC-1');
	});

	it('preserves pre-existing audit rows', async () => {
		const kept = await h.db.query<{ id: string }>(
			`SELECT id FROM audit_log WHERE id = ANY($1::uuid[])`,
			[auditIds],
		);
		expect(kept.rows.length).toBe(3);
	});

	// The point of the audit indexes is the seek predicate the activity feed
	// pages with, now that it is keyset rather than LIMIT/OFFSET + COUNT(*).
	it('serves the keyset seek, walking every audit row exactly once across pages', async () => {
		const seen: string[] = [];
		let cursor: { created_at: string; id: string } | null = null;

		for (let page = 0; page < 5; page++) {
			const rows = cursor
				? await h.db.query<{ id: string; created_at: string }>(
						`SELECT id, created_at FROM audit_log
						 WHERE (created_at, id) < ($1::timestamptz, $2::uuid)
						 ORDER BY created_at DESC, id DESC LIMIT 2`,
						[cursor.created_at, cursor.id],
					)
				: await h.db.query<{ id: string; created_at: string }>(
						`SELECT id, created_at FROM audit_log
						 ORDER BY created_at DESC, id DESC LIMIT 2`,
					);
			if (rows.rows.length === 0) break;
			for (const row of rows.rows) seen.push(row.id);
			const last = rows.rows[rows.rows.length - 1];
			cursor = { created_at: new Date(last.created_at).toISOString(), id: last.id };
		}

		// Every seeded row appears once, despite all three sharing a timestamp.
		expect(seen.length).toBe(3);
		expect(new Set(seen).size).toBe(3);
		expect(seen.slice().sort()).toEqual(auditIds.slice().sort());
	});

	it('still serves the queries the indexes were added for', async () => {
		// The 5s heartbeat scan's recency test.
		const recent = await h.db.query(
			`SELECT 1 FROM heartbeat_runs
			 WHERE member_id = $1 AND finished_at IS NOT NULL
			   AND finished_at > now() - interval '60 seconds'`,
			[memberId],
		);
		expect(recent.rows.length).toBe(1);

		// The task's latest run.
		const latest = await h.db.query<{ id: string }>(
			`SELECT id FROM heartbeat_runs WHERE task_id = $1 ORDER BY started_at DESC LIMIT 1`,
			[taskId],
		);
		expect(latest.rows[0].id).toBe(runId);

		// The dispatcher scan.
		const queued = await h.db.query<{ id: string }>(
			`SELECT id FROM agent_wakeup_requests
			 WHERE status = 'queued'::wakeup_status ORDER BY created_at ASC LIMIT 10`,
		);
		expect(queued.rows.map((r) => r.id)).toContain(wakeupId);
	});
});
