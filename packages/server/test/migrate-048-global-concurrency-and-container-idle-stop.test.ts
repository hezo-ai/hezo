import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '048_global_concurrency_and_container_idle_stop.sql';

describe('048_global_concurrency_and_container_idle_stop migration', () => {
	let h: DataPreservationHarness;
	let runningProjectId: string;
	let stoppedProjectId: string;
	let runId: string;
	let sessionId: string;
	let messageId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// projects.team_id is UNIQUE (1:1 team↔project), so each project needs its own team.
		const newTeam = async (slug: string): Promise<string> => {
			const t = await h.db.query<{ id: string }>(
				`INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id`,
				[slug],
			);
			return t.rows[0].id;
		};

		// A project with a running container, a custom concurrency value, and the
		// old memory default (16) — the dropped column must not take the rest of
		// the row with it, and the 16 must convert to NULL (inherit).
		const runningTeamId = await newTeam('team-running');
		const running = await h.db.query<{ id: string; memory_limit_gib: number }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, max_concurrent_runs, container_id, container_status)
			 VALUES ($1, 'Running', 'running', 'RUN', 5, 'cid-running', 'running')
			 RETURNING id, memory_limit_gib`,
			[runningTeamId],
		);
		runningProjectId = running.rows[0].id;
		// Guard the premise: the pre-migration memory default really is 16.
		expect(running.rows[0].memory_limit_gib).toBe(16);

		// A project whose container is stopped (023 concurrency default of 10) and
		// whose memory cap an operator explicitly customized — must be preserved.
		const stopped = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, container_id, container_status, memory_limit_gib)
			 VALUES ($1, 'Stopped', 'stopped', 'STO', 'cid-stopped', 'stopped', 8) RETURNING id`,
			[await newTeam('team-stopped')],
		);
		stoppedProjectId = stopped.rows[0].id;

		// A finished run — the new idx_runs_finished must not disturb existing rows.
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Agent') RETURNING id`,
			[runningTeamId],
		);
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'RUN-1', 'Task') RETURNING id`,
			[runningTeamId, runningProjectId],
		);
		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, finished_at)
			 VALUES ($1, $2, $3, 'succeeded', now() - interval '1 hour') RETURNING id`,
			[runningTeamId, member.rows[0].id, task.rows[0].id],
		);
		runId = run.rows[0].id;

		// A chat session with an in-flight message — the new partial index on
		// chat_messages must not disturb existing rows.
		const conversation = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, title)
			 VALUES ($1, $2, $3, 'Chat') RETURNING id`,
			[member.rows[0].id, runningTeamId, runningProjectId],
		);
		const session = await h.db.query<{ id: string }>(
			`INSERT INTO chat_sessions (member_id, team_id, project_id, runtime_type, status)
			 VALUES ($1, $2, $3, 'claude_code', 'running') RETURNING id`,
			[member.rows[0].id, runningTeamId, runningProjectId],
		);
		sessionId = session.rows[0].id;
		const message = await h.db.query<{ id: string }>(
			`INSERT INTO chat_messages (conversation_id, role, status, content, session_id)
			 VALUES ($1, 'assistant', 'streaming', '', $2) RETURNING id`,
			[conversation.rows[0].id, sessionId],
		);
		messageId = message.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('drops the max_concurrent_runs column', async () => {
		const c = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.columns
			 WHERE table_name = 'projects' AND column_name = 'max_concurrent_runs'`,
		);
		expect(c.rows[0].c).toBe(0);
	});

	it('makes memory_limit_gib nullable with no default, converting old-default rows to inherit', async () => {
		const col = await h.db.query<{ is_nullable: string; column_default: string | null }>(
			`SELECT is_nullable, column_default FROM information_schema.columns
			 WHERE table_name = 'projects' AND column_name = 'memory_limit_gib'`,
		);
		expect(col.rows[0]).toMatchObject({ is_nullable: 'YES', column_default: null });

		const rows = await h.db.query<{ id: string; memory_limit_gib: number | null }>(
			`SELECT id, memory_limit_gib FROM projects WHERE id = ANY($1::uuid[])`,
			[[runningProjectId, stoppedProjectId]],
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r.memory_limit_gib]));
		expect(byId.get(runningProjectId)).toBeNull(); // was on the old default 16
		expect(byId.get(stoppedProjectId)).toBe(8); // explicit override preserved
	});

	it('adds container_last_started_at, backfilled only for running containers', async () => {
		const rows = await h.db.query<{ id: string; container_last_started_at: string | null }>(
			`SELECT id, container_last_started_at FROM projects WHERE id = ANY($1::uuid[])`,
			[[runningProjectId, stoppedProjectId]],
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r.container_last_started_at]));
		expect(byId.get(runningProjectId)).not.toBeNull();
		expect(byId.get(stoppedProjectId)).toBeNull();
	});

	it('creates the two idle-stop indexes', async () => {
		const idx = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes
			 WHERE indexname IN ('idx_runs_finished', 'idx_chat_messages_inflight')`,
		);
		expect(idx.rows.map((r) => r.indexname).sort()).toEqual([
			'idx_chat_messages_inflight',
			'idx_runs_finished',
		]);
	});

	it('preserves pre-existing projects, runs, and chat rows', async () => {
		const projects = await h.db.query<{ id: string; container_id: string; slug: string }>(
			`SELECT id, container_id, slug FROM projects WHERE id = ANY($1::uuid[]) ORDER BY slug`,
			[[runningProjectId, stoppedProjectId]],
		);
		expect(projects.rows).toHaveLength(2);
		expect(projects.rows[0]).toMatchObject({ slug: 'running', container_id: 'cid-running' });
		expect(projects.rows[1]).toMatchObject({ slug: 'stopped', container_id: 'cid-stopped' });

		const run = await h.db.query<{ status: string }>(
			`SELECT status FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		expect(run.rows[0]?.status).toBe('succeeded');

		const msg = await h.db.query<{ status: string; session_id: string }>(
			`SELECT status, session_id FROM chat_messages WHERE id = $1`,
			[messageId],
		);
		expect(msg.rows[0]).toMatchObject({ status: 'streaming', session_id: sessionId });
	});
});
