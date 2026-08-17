import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '063_run_health.sql';

describe('063_run_health migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let memberId: string;
	let taskId: string;
	let runId: string;
	let textCommentId: string;
	let systemCommentId: string;
	let runCommentId: string;
	let queuedWakeupId: string;
	let completedWakeupId: string;
	let uncredentialedConnectorId: string;
	let credentialedConnectorId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 063

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
			 VALUES ($1, $2, 1, 'AC-1', 'Standing check') RETURNING id`,
			[teamId, project.rows[0].id],
		);
		taskId = task.rows[0].id;
		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status) RETURNING id`,
			[teamId, memberId, taskId],
		);
		runId = run.rows[0].id;

		// One row of each category, so the index predicate can be shown to select
		// the conversation and the events while leaving the run marker out.
		const text = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_at)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb, TIMESTAMPTZ '2026-01-02 09:00:00Z')
			 RETURNING id`,
			[taskId, memberId, JSON.stringify({ text: 'Round one is done.' })],
		);
		textCommentId = text.rows[0].id;
		const system = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content, created_at)
			 VALUES ($1, 'system'::comment_content_type, $2::jsonb, TIMESTAMPTZ '2026-01-02 10:00:00Z')
			 RETURNING id`,
			[taskId, JSON.stringify({ kind: 'status_change', text: 'moved to in_progress' })],
		);
		systemCommentId = system.rows[0].id;
		const runComment = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content, created_at)
			 VALUES ($1, 'run'::comment_content_type, $2::jsonb, TIMESTAMPTZ '2026-01-02 11:00:00Z')
			 RETURNING id`,
			[taskId, JSON.stringify({ run_id: runId })],
		);
		runCommentId = runComment.rows[0].id;

		// A queued wakeup that has already absorbed another trigger, plus a settled
		// one: both must survive the column addition with their bookkeeping intact.
		const queued = await h.db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, coalesced_count)
			 VALUES ($1, $2, 'assignment'::wakeup_source, 'queued'::wakeup_status, $3::jsonb, 2)
			 RETURNING id`,
			[memberId, teamId, JSON.stringify({ task_id: taskId })],
		);
		queuedWakeupId = queued.rows[0].id;
		const completed = await h.db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
			 VALUES ($1, $2, 'heartbeat'::wakeup_source, 'completed'::wakeup_status, '{}'::jsonb)
			 RETURNING id`,
			[memberId, teamId],
		);
		completedWakeupId = completed.rows[0].id;

		const uncredentialed = await h.db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('unverified', 'saas'::mcp_connection_kind, $1::jsonb, 'installed'::mcp_install_status)
			 RETURNING id`,
			[JSON.stringify({ url: 'https://mcp.example.test/mcp' })],
		);
		uncredentialedConnectorId = uncredentialed.rows[0].id;
		const credentialed = await h.db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status, activated_at, methods_listed_at)
			 VALUES ('connected', 'saas'::mcp_connection_kind, $1::jsonb, 'installed'::mcp_install_status,
			         now(), now())
			 RETURNING id`,
			[JSON.stringify({ url: 'https://mcp.other.test/mcp' })],
		);
		credentialedConnectorId = credentialed.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	describe('thread reads that leave out run rows', () => {
		it('creates the partial no-run comment index', async () => {
			const r = await h.db.query<{ indexdef: string }>(
				`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_comments_task_created_no_run'`,
			);
			expect(r.rows.length).toBe(1);
			const def = r.rows[0].indexdef.toLowerCase();
			expect(def).toContain('task_id');
			expect(def).toContain('created_at');
			// `id` is in the key so the keyset tuple comparison is an index condition.
			expect(def).toContain(' id ');
			// Partial is the point: a full index would not match the default predicate.
			expect(def).toContain('where');
			expect(def).toContain('run');
		});

		it('leaves the unfiltered comment index in place', async () => {
			const r = await h.db.query<{ indexname: string }>(
				`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_comments_task_created'`,
			);
			expect(r.rows.length).toBe(1);
		});

		it('selects exactly the conversation and event rows under the index predicate', async () => {
			const r = await h.db.query<{ id: string; content_type: string }>(
				`SELECT id, content_type::text AS content_type FROM task_comments
				 WHERE task_id = $1 AND content_type <> 'run'::comment_content_type
				 ORDER BY created_at ASC, id ASC`,
				[taskId],
			);
			expect(r.rows.map((c) => c.id)).toEqual([textCommentId, systemCommentId]);
			expect(r.rows.map((c) => c.content_type)).toEqual(['text', 'system']);
		});

		it('preserves every pre-existing comment, its type and its body', async () => {
			const r = await h.db.query<{ id: string; content_type: string; content: { text?: string } }>(
				`SELECT id, content_type::text AS content_type, content FROM task_comments
				 WHERE task_id = $1 ORDER BY created_at ASC, id ASC`,
				[taskId],
			);
			expect(r.rows.map((c) => c.id)).toEqual([textCommentId, systemCommentId, runCommentId]);
			expect(r.rows.map((c) => c.content_type)).toEqual(['text', 'system', 'run']);
			expect(r.rows[0].content.text).toBe('Round one is done.');
		});
	});

	describe('wakeup run attribution', () => {
		it('adds the nullable run attribution column', async () => {
			const r = await h.db.query<{ data_type: string; is_nullable: string }>(
				`SELECT data_type, is_nullable FROM information_schema.columns
				 WHERE table_name = 'agent_wakeup_requests' AND column_name = 'created_by_run_id'`,
			);
			expect(r.rows.length).toBe(1);
			expect(r.rows[0].data_type).toBe('uuid');
			expect(r.rows[0].is_nullable).toBe('YES');
		});

		it('creates the partial attribution index', async () => {
			const r = await h.db.query<{ indexdef: string }>(
				`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_wakeups_created_by_run'`,
			);
			expect(r.rows.length).toBe(1);
			const def = r.rows[0].indexdef.toLowerCase();
			expect(def).toContain('created_by_run_id');
			// Most rows are unattributed and the lookup never asks for them.
			expect(def).toContain('where');
		});

		it('preserves every pre-existing wakeup, unattributed', async () => {
			const r = await h.db.query<{
				id: string;
				status: string;
				coalesced_count: number;
				payload: { task_id?: string };
				created_by_run_id: string | null;
			}>(
				`SELECT id, status::text AS status, coalesced_count, payload, created_by_run_id
				 FROM agent_wakeup_requests WHERE team_id = $1 ORDER BY created_at ASC`,
				[teamId],
			);
			expect(r.rows.map((w) => w.id)).toEqual([queuedWakeupId, completedWakeupId]);
			expect(r.rows.map((w) => w.status)).toEqual(['queued', 'completed']);
			expect(r.rows[0].coalesced_count).toBe(2);
			expect(r.rows[0].payload.task_id).toBe(taskId);
			// The attribution did not exist before, which is what NULL means here.
			expect(r.rows.every((w) => w.created_by_run_id === null)).toBe(true);
		});

		it('accepts a run id and releases it when the run is deleted', async () => {
			await h.db.query(`UPDATE agent_wakeup_requests SET created_by_run_id = $1 WHERE id = $2`, [
				runId,
				queuedWakeupId,
			]);
			const attributed = await h.db.query<{ created_by_run_id: string | null }>(
				`SELECT created_by_run_id FROM agent_wakeup_requests WHERE id = $1`,
				[queuedWakeupId],
			);
			expect(attributed.rows[0].created_by_run_id).toBe(runId);

			// The credit lookup tolerates a run row that has since gone; the wakeup
			// itself must outlive it rather than cascade away.
			await h.db.query(`DELETE FROM heartbeat_runs WHERE id = $1`, [runId]);
			const after = await h.db.query<{ created_by_run_id: string | null }>(
				`SELECT created_by_run_id FROM agent_wakeup_requests WHERE id = $1`,
				[queuedWakeupId],
			);
			expect(after.rows.length).toBe(1);
			expect(after.rows[0].created_by_run_id).toBeNull();
		});
	});

	describe('connector probe evidence', () => {
		it('adds both probe columns, nullable', async () => {
			const r = await h.db.query<{ column_name: string; is_nullable: string }>(
				`SELECT column_name, is_nullable FROM information_schema.columns
				 WHERE table_name = 'mcp_connections' AND column_name IN ('probed_at', 'probe_error')
				 ORDER BY column_name`,
			);
			expect(r.rows.map((c) => c.column_name)).toEqual(['probe_error', 'probed_at']);
			expect(r.rows.every((c) => c.is_nullable === 'YES')).toBe(true);
		});

		it('constrains probe_error to the known failures', async () => {
			const r = await h.db.query<{ label: string }>(
				`SELECT e.enumlabel AS label FROM pg_enum e
				 JOIN pg_type t ON t.oid = e.enumtypid
				 WHERE t.typname = 'connector_probe_error' ORDER BY e.enumsortorder`,
			);
			expect(r.rows.map((v) => v.label)).toEqual(['auth_required', 'unreachable']);
		});

		it('creates the partial probe-due index, ordered nulls first', async () => {
			const r = await h.db.query<{ indexdef: string }>(
				`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_mcp_connections_probe_due'`,
			);
			expect(r.rows.length).toBe(1);
			const def = r.rows[0].indexdef.toLowerCase();
			expect(def).toContain('probed_at');
			// Never probed is the most due, and ASC would otherwise sort those last.
			expect(def).toContain('nulls first');
			expect(def).toContain('oauth_connection_id is null');
			expect(def).toContain('api_key_secret_id is null');
		});

		it('leaves every connector unproven rather than backfilling evidence', async () => {
			const r = await h.db.query<{
				id: string;
				name: string;
				config: { url?: string };
				probed_at: string | null;
				probe_error: string | null;
			}>(`SELECT id, name, config, probed_at, probe_error FROM mcp_connections ORDER BY name ASC`);
			expect(r.rows.map((c) => c.id)).toEqual([credentialedConnectorId, uncredentialedConnectorId]);
			expect(r.rows.map((c) => c.name)).toEqual(['connected', 'unverified']);
			expect(r.rows[0].config.url).toBe('https://mcp.other.test/mcp');
			expect(r.rows[1].config.url).toBe('https://mcp.example.test/mcp');
			// No SQL can probe a third-party server, so asserting the evidence here
			// would preserve the bug for exactly the rows that have it.
			expect(r.rows.every((c) => c.probed_at === null && c.probe_error === null)).toBe(true);
		});

		it('selects the uncredentialed connector the sweep must re-probe, never-probed first', async () => {
			await h.db.query(`UPDATE mcp_connections SET probed_at = now() WHERE id = $1`, [
				credentialedConnectorId,
			]);
			const r = await h.db.query<{ id: string }>(
				`SELECT id FROM mcp_connections
				 WHERE kind = 'saas' AND revoked_at IS NULL
				   AND oauth_connection_id IS NULL AND api_key_secret_id IS NULL
				 ORDER BY probed_at ASC NULLS FIRST, created_at ASC`,
			);
			expect(r.rows[0].id).toBe(uncredentialedConnectorId);
		});
	});
});
