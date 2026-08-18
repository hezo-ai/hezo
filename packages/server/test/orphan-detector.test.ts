import {
	AgentRuntimeStatus,
	ApprovalType,
	HeartbeatRunStatus,
	RunCancelReason,
	WakeupSkipReason,
	WakeupSource,
	WakeupStatus,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { appendRunLogChunks } from '../src/db/run-log-chunks';
import type { Env } from '../src/lib/types';
import {
	CAPACITY_PARK_MAX_MS,
	createHeartbeatRun,
	extractReplacedRun,
} from '../src/services/agent-runner';
import {
	detectOrphans,
	healStaleRunState,
	MAX_RETRIES,
	STALE_STATE_GRACE_SECONDS,
} from '../src/services/orphan-detector';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	projectSlugFor,
} from './helpers/app';

let db: Db;
let app: Hono<Env>;
let token: string;
let teamId: string;
let teamSlug: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;

	const teamRes = await createTestTeam(db, {
		name: 'Orphan Test Co',

		template_id: teamTemplateId,
	});
	const team = (await teamRes.json()).data as { id: string; slug: string };
	teamId = team.id;
	teamSlug = team.slug;

	const agentsRes = await app.request(`/api/projects/${await projectSlugFor(db, teamId)}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

async function insertOrphanRun(
	memberId: string,
	coId: string,
	opts: { retryCount?: number } = {},
): Promise<string> {
	const { retryCount = 0 } = opts;
	const result = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs
		   (team_id, member_id, status, started_at, process_loss_retry_count)
		 VALUES ($1, $2, $3::heartbeat_run_status, now() - interval '10 minutes', $4)
		 RETURNING id`,
		[coId, memberId, HeartbeatRunStatus.Running, retryCount],
	);
	return result.rows[0].id;
}

async function setAgentActive(memberId: string): Promise<void> {
	await db.query(
		`UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2`,
		[AgentRuntimeStatus.Active, memberId],
	);
}

async function insertLock(memberId: string, taskId: string): Promise<string> {
	const result = await db.query<{ id: string }>(
		`INSERT INTO execution_locks (task_id, member_id) VALUES ($1, $2) RETURNING id`,
		[taskId, memberId],
	);
	return result.rows[0].id;
}

async function createTask(coId: string): Promise<string> {
	const projectRes = await createTestProject(db, coId, {
		name: 'Orphan Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;
	const projectId = project.id;

	const taskRes = await app.request(`/api/projects/${project.slug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Orphan Task', assignee_id: agentId }),
	});
	return (await taskRes.json()).data.id;
}

describe('detectOrphans', () => {
	it('returns 0 when no orphaned runs exist', async () => {
		// Clean state — no non-terminal heartbeat runs of either kind
		await db.query(
			`DELETE FROM heartbeat_runs
			 WHERE team_id = $1 AND status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)`,
			[teamId, HeartbeatRunStatus.Running, HeartbeatRunStatus.Queued],
		);

		const count = await detectOrphans(db, new Set());
		expect(count).toBe(0);
	});

	it('detects orphaned heartbeat runs and marks them failed', async () => {
		const runId = await insertOrphanRun(agentId, teamId);

		const count = await detectOrphans(db, new Set());
		expect(count).toBeGreaterThanOrEqual(1);

		const run = await db.query<{ status: string; error: string; finished_at: string | null }>(
			'SELECT status, error, finished_at FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].error).toContain('Orphaned');
		expect(run.rows[0].finished_at).not.toBeNull();
	});

	it('skips runs whose id is in the live-run registry', async () => {
		const runId = await insertOrphanRun(agentId, teamId);

		await detectOrphans(db, new Set([runId]));

		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Running);

		await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [runId]);
	});

	it('resets member_agents.runtime_status from active to idle when no other live run remains', async () => {
		await db.query(
			`DELETE FROM heartbeat_runs
			 WHERE team_id = $1 AND status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)`,
			[teamId, HeartbeatRunStatus.Running, HeartbeatRunStatus.Queued],
		);
		await setAgentActive(agentId);
		await insertOrphanRun(agentId, teamId);

		await detectOrphans(db, new Set());

		const agent = await db.query<{ runtime_status: string }>(
			'SELECT runtime_status FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);
	});

	it('releases execution locks for orphaned agents', async () => {
		const taskId = await createTask(teamId);
		const lockId = await insertLock(agentId, taskId);
		await insertOrphanRun(agentId, teamId);

		await detectOrphans(db, new Set());

		const lock = await db.query<{ released_at: string | null }>(
			'SELECT released_at FROM execution_locks WHERE id = $1',
			[lockId],
		);
		expect(lock.rows[0].released_at).not.toBeNull();
	});

	it('creates a retry wakeup when retry count < 3', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		await insertOrphanRun(agentId, teamId, { retryCount: 1 });

		await detectOrphans(db, new Set());

		const wakeups = await db.query<{ source: string; payload: unknown }>(
			`SELECT source, payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND source = $2
			 ORDER BY created_at DESC
			 LIMIT 1`,
			[agentId, WakeupSource.Timer],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
		const payload = wakeups.rows[0].payload as Record<string, unknown>;
		expect(payload.reason).toBe('orphan_retry');
	});

	it('the retry chain terminates, because a retried run inherits the count', async () => {
		// The bug this exists for: `createHeartbeatRun` wrote neither
		// `retry_of_run_id` nor `process_loss_retry_count`, so every retried run
		// started at 0, `0 + 1 < MAX_RETRIES` was always true, and the escalation
		// below was unreachable. The old coverage set the counter by hand on one
		// row and so never drove reap -> wakeup -> new run -> reap at all.
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
		await db.query('DELETE FROM approvals WHERE team_id = $1', [teamId]);

		const latestRetryPayload = async (): Promise<Record<string, unknown> | null> => {
			const res = await db.query<{ payload: Record<string, unknown> }>(
				`SELECT payload FROM agent_wakeup_requests
				 WHERE member_id = $1 AND payload->>'reason' = 'orphan_retry'
				 ORDER BY created_at DESC LIMIT 1`,
				[agentId],
			);
			return res.rows[0]?.payload ?? null;
		};

		// The replacement run the dispatcher would create for that retry wakeup.
		const runReplacing = async (payload: Record<string, unknown>): Promise<string> => {
			// Settle the queued retry first, exactly as dispatching it would. Left
			// queued, the *next* reap's wakeup coalesces onto it (both are task-less)
			// and its payload never advances.
			await db.query(
				`UPDATE agent_wakeup_requests SET status = $1::wakeup_status
				 WHERE member_id = $2 AND status = $3::wakeup_status
				   AND payload->>'reason' = 'orphan_retry'`,
				[WakeupStatus.Completed, agentId, WakeupStatus.Queued],
			);
			const wakeup = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, payload, status)
				 VALUES ($1, $2, $3::wakeup_source, $4::jsonb, $5::wakeup_status) RETURNING id`,
				[agentId, teamId, WakeupSource.Timer, JSON.stringify(payload), WakeupStatus.Claimed],
			);
			return createHeartbeatRun(
				db,
				{ id: agentId, title: 'A', slug: 'a', team_id: teamId } as never,
				teamId,
				null,
				{ teamId, taskId: null, memberId: agentId },
				wakeup.rows[0].id,
				null,
				undefined,
				extractReplacedRun(payload),
			);
		};

		const countOf = async (id: string): Promise<number> => {
			const r = await db.query<{ n: number; retry_of: string | null }>(
				'SELECT process_loss_retry_count AS n, retry_of_run_id AS retry_of FROM heartbeat_runs WHERE id = $1',
				[id],
			);
			return r.rows[0].n;
		};
		const lineageOf = async (id: string): Promise<string | null> => {
			const r = await db.query<{ retry_of: string | null }>(
				'SELECT retry_of_run_id AS retry_of FROM heartbeat_runs WHERE id = $1',
				[id],
			);
			return r.rows[0].retry_of;
		};

		const runA = await insertOrphanRun(agentId, teamId, {});
		await detectOrphans(db, new Set());
		const payloadA = await latestRetryPayload();
		expect(payloadA?.retry_count).toBe(1);

		const runB = await runReplacing(payloadA as Record<string, unknown>);
		expect(await countOf(runB)).toBe(1);
		expect(await lineageOf(runB)).toBe(runA);

		await db.query(
			`UPDATE heartbeat_runs SET status = $1::heartbeat_run_status,
			   started_at = now() - interval '10 minutes' WHERE id = $2`,
			[HeartbeatRunStatus.Running, runB],
		);
		await detectOrphans(db, new Set());
		const payloadB = await latestRetryPayload();
		expect(payloadB?.retry_count).toBe(2);

		const runC = await runReplacing(payloadB as Record<string, unknown>);
		expect(await countOf(runC)).toBe(2);
		expect(await lineageOf(runC)).toBe(runB);

		// The ceiling. Reaping C must escalate rather than mint a fourth attempt.
		const retriesBefore = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'reason' = 'orphan_retry'`,
			[agentId],
		);
		await db.query(
			`UPDATE heartbeat_runs SET status = $1::heartbeat_run_status,
			   started_at = now() - interval '10 minutes' WHERE id = $2`,
			[HeartbeatRunStatus.Running, runC],
		);
		await detectOrphans(db, new Set());

		const retriesAfter = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'reason' = 'orphan_retry'`,
			[agentId],
		);
		expect(retriesAfter.rows[0].c).toBe(retriesBefore.rows[0].c);

		const approvals = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM approvals
			 WHERE team_id = $1 AND payload->>'type' = 'agent_error'`,
			[teamId],
		);
		expect(approvals.rows[0].c).toBe(1);

		// A second ceiling files nothing new: one record per stuck agent.
		const runD = await insertOrphanRun(agentId, teamId, { retryCount: 2 });
		await detectOrphans(db, new Set());
		expect(await countOf(runD)).toBe(3);
		const approvalsAgain = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM approvals
			 WHERE team_id = $1 AND payload->>'type' = 'agent_error'`,
			[teamId],
		);
		expect(approvalsAgain.rows[0].c).toBe(1);
	});

	it('creates an approval request when retry count >= 3 (MAX_RETRIES)', async () => {
		await db.query('DELETE FROM approvals WHERE team_id = $1', [teamId]);

		// retry_count = 2, so process_loss_retry_count + 1 = 3 which is not < MAX_RETRIES (3)
		await insertOrphanRun(agentId, teamId, { retryCount: 2 });

		await detectOrphans(db, new Set());

		const approvals = await db.query<{ type: string; payload: unknown }>(
			`SELECT type, payload FROM approvals
			 WHERE team_id = $1 AND type = $2::approval_type
			 ORDER BY created_at DESC
			 LIMIT 1`,
			[teamId, ApprovalType.Strategy],
		);
		expect(approvals.rows.length).toBeGreaterThanOrEqual(1);
		const payload = approvals.rows[0].payload as Record<string, unknown>;
		expect(payload.type).toBe('agent_error');
		expect(payload.member_id).toBe(agentId);
	});

	it('returns correct orphan count for multiple orphans', async () => {
		// Remove all existing non-terminal runs
		await db.query(
			`DELETE FROM heartbeat_runs
			 WHERE team_id = $1 AND status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)`,
			[teamId, HeartbeatRunStatus.Running, HeartbeatRunStatus.Queued],
		);

		// Insert 3 orphaned runs (no PIDs)
		await insertOrphanRun(agentId, teamId);
		await insertOrphanRun(agentId, teamId);
		await insertOrphanRun(agentId, teamId);

		const count = await detectOrphans(db, new Set());
		expect(count).toBe(3);
	});
});

describe('detectOrphans for runs stranded before they started', () => {
	/** A `queued` run has no `started_at`, so it ages against `created_at`. */
	async function insertQueuedRun(
		age: string,
		opts: { taskId?: string; inheritFrom?: string | null } = {},
	): Promise<string> {
		const result = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, created_at,
			                             retry_of_run_id, process_loss_retry_count)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - $5::interval, $6,
			         COALESCE((SELECT prior.process_loss_retry_count
			                     FROM heartbeat_runs prior WHERE prior.id = $6), 0))
			 RETURNING id`,
			[
				teamId,
				agentId,
				opts.taskId ?? null,
				HeartbeatRunStatus.Queued,
				age,
				opts.inheritFrom ?? null,
			],
		);
		return result.rows[0].id;
	}

	async function abandonedNotices(forTaskId: string): Promise<number> {
		const r = await db.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM task_comments
			 WHERE task_id = $1 AND content->>'kind' = 'run_abandoned'`,
			[forTaskId],
		);
		return Number(r.rows[0].count);
	}

	async function clearRuns(): Promise<void> {
		await db.query(
			`DELETE FROM heartbeat_runs
			 WHERE team_id = $1 AND status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)`,
			[teamId, HeartbeatRunStatus.Running, HeartbeatRunStatus.Queued],
		);
	}

	it('cancels a queued run whose driver never started it, and frees the state it pinned', async () => {
		await clearRuns();
		const taskId = await createTask(teamId);
		const lockId = await insertLock(agentId, taskId);
		await setAgentActive(agentId);
		const runId = await insertQueuedRun('10 minutes', { taskId });

		const count = await detectOrphans(db, new Set());
		expect(count).toBe(1);

		const run = await db.query<{
			status: string;
			error: string;
			finished_at: string | null;
			process_loss_retry_count: number;
		}>(
			'SELECT status, error, finished_at, process_loss_retry_count FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		// Cancelled, not failed: the run never started, so nothing ran and nothing
		// was lost. Failing it filled the Errored view with unactionable rows.
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Cancelled);
		expect(run.rows[0].error).toContain('Never started');
		expect(run.rows[0].finished_at).not.toBeNull();
		// This run had no wakeup to hand back, so the work was carried by a fresh
		// replacement run - and minting one spends a strike, which is what bounds
		// the chain. Only a genuine handback of the original wakeup is free (see
		// `hands the original wakeup back...` below): there the dispatcher already
		// owns the work and no new attempt was made.
		expect(run.rows[0].process_loss_retry_count).toBe(1);

		// The point of the reap: the task stops reading as having an active run,
		// which is what blocks reassignment and shows the agent as busy.
		const active = await db.query<{ has_active_run: boolean }>(
			`SELECT EXISTS (
			   SELECT 1 FROM heartbeat_runs hr
			   WHERE hr.task_id = $1 AND hr.status IN ('running', 'queued')
			 ) AS has_active_run`,
			[taskId],
		);
		expect(active.rows[0].has_active_run).toBe(false);

		const lock = await db.query<{ released_at: string | null }>(
			'SELECT released_at FROM execution_locks WHERE id = $1',
			[lockId],
		);
		expect(lock.rows[0].released_at).not.toBeNull();

		const agent = await db.query<{ runtime_status: string }>(
			'SELECT runtime_status FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);
	});

	it('hands the original wakeup back to the queue instead of minting a retry', async () => {
		await clearRuns();
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, claimed_at)
			 VALUES ($1, $2, $3::wakeup_source, $4::wakeup_status, now())
			 RETURNING id`,
			[agentId, teamId, WakeupSource.Timer, WakeupStatus.Claimed],
		);
		const wakeupId = wakeup.rows[0].id;
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, wakeup_id, status, created_at)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '10 minutes')`,
			[teamId, agentId, wakeupId, HeartbeatRunStatus.Queued],
		);

		expect(await detectOrphans(db, new Set())).toBe(1);

		// The work is put back on the row that already carries it - the dispatcher
		// picks it up on the next tick.
		const settled = await db.query<{ status: string; claimed_at: string | null }>(
			'SELECT status, claimed_at FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(settled.rows[0].status).toBe(WakeupStatus.Queued);
		expect(settled.rows[0].claimed_at).toBeNull();

		// And no second wakeup was created for the same work.
		const all = await db.query<{ count: string }>(
			'SELECT count(*)::text AS count FROM agent_wakeup_requests WHERE member_id = $1',
			[agentId],
		);
		expect(all.rows[0].count).toBe('1');

		// Handing the original row back spends no strike: nothing was attempted,
		// the dispatcher already owns the work, and charging the lost-run budget
		// for it is what let an inherited count dead-end this arm permanently.
		const strikes = await db.query<{ process_loss_retry_count: number }>(
			'SELECT process_loss_retry_count FROM heartbeat_runs WHERE wakeup_id = $1',
			[wakeupId],
		);
		expect(strikes.rows[0].process_loss_retry_count).toBe(0);

		// The row says what actually happened, and only after it happened.
		const run = await db.query<{ error: string }>(
			'SELECT error FROM heartbeat_runs WHERE wakeup_id = $1',
			[wakeupId],
		);
		expect(run.rows[0].error).toContain('back in the queue');
		expect(run.rows[0].error).toContain('Never started');
	});

	it('carries the real cause into the error so the run page does not just say it never started', async () => {
		await clearRuns();
		const runId = await insertQueuedRun('10 minutes');
		await appendRunLogChunks(
			db,
			runId,
			'[runner] no container available for project abc: its next container does not fit ' +
				'the instance memory budget - returning this run to the queue.\n',
		);

		expect(await detectOrphans(db, new Set())).toBe(1);

		const run = await db.query<{ error: string }>(
			'SELECT error FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].error).toContain('Never started');
		expect(run.rows[0].error).toContain('no container available');
	});

	it('broadcasts a project even for a task-less run, so an open page can map the change', async () => {
		// The client resolves a heartbeat_runs change by project_id alone and skips
		// a row without one (PROJECT_STRICT_TABLES). A progress-update run carries
		// no task, so deriving the project from the task left these reaps reaching
		// no open page - the reader watched a queued run that had already ended.
		await clearRuns();
		const runId = await insertQueuedRun('10 minutes');
		const sent: Record<string, unknown>[] = [];
		const wsManager = {
			broadcast: (_room: string, msg: { row: Record<string, unknown> }) => {
				sent.push(msg.row);
			},
		} as unknown as Parameters<typeof detectOrphans>[2];

		expect(await detectOrphans(db, new Set(), wsManager)).toBe(1);

		const row = sent.find((r) => r.id === runId);
		expect(row).toBeDefined();
		expect(row?.project_id).toBeTruthy();
		expect(row?.status).toBe(HeartbeatRunStatus.Cancelled);
		// And it carries the FINAL text, not the provisional verdict. The reap
		// writes the verdict alone and the outcome is appended only once the work
		// has been settled; broadcasting between the two would push a sentence to an
		// open run page that the row no longer says. Asserting only id/status left
		// that ordering unobserved - reverting it broke nothing.
		expect(String(row?.error ?? '')).toContain('Never started');
		expect(String(row?.error ?? '')).toContain('queue');
	});

	it('capacity-park-grace: a park outliving the grace window is survivable, not a failure', async () => {
		// The park deliberately runs past the age at which this pass would consider
		// its row, and is kept safe only by the live-run registry. That registry is
		// in-memory, so a restart mid-park hands every parked row straight to this
		// pass. The pairing is only tolerable while the verdict for a run that
		// never started is non-terminal for the *work* - cancel the row, hand the
		// wakeup back. If someone shortens the grace or lengthens the park, this is
		// the assumption they are leaning on.
		expect(CAPACITY_PARK_MAX_MS).toBeGreaterThan(STALE_STATE_GRACE_SECONDS * 1000);

		await clearRuns();
		const runId = await insertQueuedRun('10 minutes');
		expect(await detectOrphans(db, new Set())).toBe(1);
		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Cancelled);
	});

	it('leaves a queued run alone while its driver still holds it (waiting on a credential lock)', async () => {
		await clearRuns();
		const runId = await insertQueuedRun('10 minutes');

		const count = await detectOrphans(db, new Set([runId]));
		expect(count).toBe(0);

		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Queued);
	});

	it('leaves a queued run alone inside the grace window', async () => {
		await clearRuns();
		const runId = await insertQueuedRun('5 seconds');

		const count = await detectOrphans(db, new Set());
		expect(count).toBe(0);

		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Queued);

		await clearRuns();
	});

	it('reports the two stranded kinds with distinct verdicts in one pass', async () => {
		await clearRuns();
		const queuedId = await insertQueuedRun('10 minutes');
		const runningId = await insertOrphanRun(agentId, teamId);

		expect(await detectOrphans(db, new Set())).toBe(2);

		const runs = await db.query<{ id: string; error: string; status: string }>(
			'SELECT id, error, status FROM heartbeat_runs WHERE id = ANY($1::uuid[])',
			[[queuedId, runningId]],
		);
		const byId = new Map(runs.rows.map((r) => [r.id, r]));
		// Never started is not a failure: nothing ran, so nothing failed.
		expect(byId.get(queuedId)?.status).toBe(HeartbeatRunStatus.Cancelled);
		expect(byId.get(queuedId)?.error).toContain('Never started');
		// A process that vanished mid-run is.
		expect(byId.get(runningId)?.status).toBe(HeartbeatRunStatus.Failed);
		expect(byId.get(runningId)?.error).toContain('Orphaned: nothing was driving this run');
	});

	it('replaces a wakeup it cannot hand back, keeping the source that decides the gates', async () => {
		// The downgrade this closes: when the handback guard misses, the fallback
		// used to mint a `timer` wakeup whatever the original was. `timer` is in
		// GATED_WAKEUP_SOURCES and is not exempt from the no-work backoff, while a
		// `mention` is neither - so a teammate's direct ask came back as a wakeup
		// the dependency gate could park indefinitely.
		await clearRuns();
		const taskId = await createTask(teamId);
		// After createTask: assigning the task fires its own `assignment` wakeup,
		// which would otherwise be the row these assertions find.
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
		// Already settled, so the `claimed`-only handback guard cannot take it.
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
			 VALUES ($1, $2, $3::wakeup_source, $4::wakeup_status, $5::jsonb)
			 RETURNING id`,
			[
				agentId,
				teamId,
				WakeupSource.Mention,
				WakeupStatus.Failed,
				JSON.stringify({ task_id: taskId }),
			],
		);
		const runId = await insertQueuedRun('10 minutes', { taskId });
		await db.query('UPDATE heartbeat_runs SET wakeup_id = $1 WHERE id = $2', [
			wakeup.rows[0].id,
			runId,
		]);

		expect(await detectOrphans(db, new Set())).toBe(1);

		const replacement = await db.query<{ source: string; payload: Record<string, unknown> }>(
			`SELECT source, payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND status = $2::wakeup_status`,
			[agentId, WakeupStatus.Queued],
		);
		expect(replacement.rows).toHaveLength(1);
		expect(replacement.rows[0].source).toBe(WakeupSource.Mention);
		expect(replacement.rows[0].payload.task_id).toBe(taskId);
		// Lineage under `previous_failure.run_id`, the one key RUN_LINEAGE_SOURCES
		// gives the loss budget to. The strike this arm just spent has to travel to
		// the replacement or the ceiling can never be reached - see the lap-by-lap
		// test above.
		expect((replacement.rows[0].payload.previous_failure as { run_id: string }).run_id).toBe(runId);
		expect(replacement.rows[0].payload.previous_run_id).toBeUndefined();

		// And the row says a fresh run was queued, not that the original went back.
		const run = await db.query<{ error: string }>(
			'SELECT error FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].error).toContain('A fresh run has been queued');
	});

	it('hands back a wakeup that names no task, because that means "find work"', async () => {
		// A heartbeat wakeup carries no `task_id` - `activateAgent` chooses the task
		// - so a guard requiring the payload to name one skipped every heartbeat and
		// left the original dangling in `claimed` for healStaleRunState to mislabel
		// `failed`. That guard was written for "intent-less" synthetic wakeups, which
		// are only ever minted for task-less progress-update runs and so never met
		// it. A wakeup naming no task is not intent-less; handing it back says
		// exactly what it said the first time.
		await clearRuns();
		const taskId = await createTask(teamId);
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
		const heartbeat = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
			 VALUES ($1, $2, $3::wakeup_source, $4::wakeup_status, '{}'::jsonb, now())
			 RETURNING id`,
			[agentId, teamId, WakeupSource.Heartbeat, WakeupStatus.Claimed],
		);
		const runId = await insertQueuedRun('10 minutes', { taskId });
		await db.query('UPDATE heartbeat_runs SET wakeup_id = $1 WHERE id = $2', [
			heartbeat.rows[0].id,
			runId,
		]);

		expect(await detectOrphans(db, new Set())).toBe(1);

		const settled = await db.query<{ status: string; last_skipped_reason: string | null }>(
			'SELECT status, last_skipped_reason FROM agent_wakeup_requests WHERE id = $1',
			[heartbeat.rows[0].id],
		);
		expect(settled.rows[0].status).toBe(WakeupStatus.Queued);
		// And it is labelled for what it is. Stamping `instance_at_capacity` here -
		// which this used to - has the idle pass reclaim the project's container out
		// from under work that dispatches on the next tick.
		expect(settled.rows[0].last_skipped_reason).toBe(WakeupSkipReason.RunNeverStarted);

		// No replacement was minted: the original still carries the work.
		const all = await db.query<{ count: string }>(
			'SELECT count(*)::text AS count FROM agent_wakeup_requests WHERE member_id = $1',
			[agentId],
		);
		expect(all.rows[0].count).toBe('1');
	});

	it('an inherited retry count does not dead-end a run that never started', async () => {
		// The permanent dead end: this arm read `process_loss_retry_count` for its
		// ceiling but never incremented it, and `createHeartbeatRun` inherits the
		// count down an orphan-retry lineage. So an inherited 2 filed one approval,
		// guarded NOT EXISTS per member, and queued nothing ever again.
		await clearRuns();
		await db.query('DELETE FROM approvals WHERE team_id = $1', [teamId]);
		const taskId = await createTask(teamId);
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
		const runId = await insertQueuedRun('10 minutes', { taskId });
		await db.query('UPDATE heartbeat_runs SET process_loss_retry_count = 1 WHERE id = $1', [runId]);

		expect(await detectOrphans(db, new Set())).toBe(1);

		const queued = await db.query<{ id: string }>(
			`SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND status = $2::wakeup_status`,
			[agentId, WakeupStatus.Queued],
		);
		expect(queued.rows).toHaveLength(1);
		const approvals = await db.query<{ id: string }>(
			'SELECT id FROM approvals WHERE team_id = $1',
			[teamId],
		);
		expect(approvals.rows).toHaveLength(0);
	});

	it('records the cancel attribution and posts a notice only when work is abandoned', async () => {
		// Three writers set `cancel_reason` and none of them was asserted, so the
		// Retry button and the thread fold could both be silently killed. And the
		// notice was untested in BOTH directions: it could be removed entirely, or
		// fired on every requeue, with the suite green either way.
		await clearRuns();
		await db.query('DELETE FROM approvals WHERE team_id = $1', [teamId]);
		const taskId = await createTask(teamId);
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
		await db.query('DELETE FROM task_comments WHERE task_id = $1', [taskId]);

		// A run whose work goes back on the queue is not something to act on.
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
			 VALUES ($1, $2, $3::wakeup_source, $4::wakeup_status, jsonb_build_object('task_id', $5::text), now())
			 RETURNING id`,
			[agentId, teamId, WakeupSource.Mention, WakeupStatus.Claimed, taskId],
		);
		const requeuedRun = await insertQueuedRun('10 minutes', { taskId });
		await db.query('UPDATE heartbeat_runs SET wakeup_id = $1 WHERE id = $2', [
			wakeup.rows[0].id,
			requeuedRun,
		]);
		expect(await detectOrphans(db, new Set())).toBe(1);

		const handed = await db.query<{ cancel_reason: string | null }>(
			'SELECT cancel_reason FROM heartbeat_runs WHERE id = $1',
			[requeuedRun],
		);
		expect(handed.rows[0].cancel_reason).toBe(RunCancelReason.HandedBack);
		expect(await abandonedNotices(taskId)).toBe(0);

		// A run nothing is carrying is. Drive it to the ceiling.
		await clearRuns();
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
		const abandonedRun = await insertQueuedRun('10 minutes', { taskId });
		await db.query('UPDATE heartbeat_runs SET process_loss_retry_count = $1 WHERE id = $2', [
			MAX_RETRIES - 1,
			abandonedRun,
		]);
		expect(await detectOrphans(db, new Set())).toBe(1);

		const abandoned = await db.query<{ cancel_reason: string | null }>(
			'SELECT cancel_reason FROM heartbeat_runs WHERE id = $1',
			[abandonedRun],
		);
		expect(abandoned.rows[0].cancel_reason).toBe(RunCancelReason.Abandoned);
		// Exactly one, naming the run whose card carries the Retry button.
		expect(await abandonedNotices(taskId)).toBe(1);
		const notice = await db.query<{ content: { run_id?: string } }>(
			`SELECT content FROM task_comments
			 WHERE task_id = $1 AND content->>'kind' = 'run_abandoned'`,
			[taskId],
		);
		expect(notice.rows[0].content.run_id).toBe(abandonedRun);
	});

	it("leaves a human's own cancel attribution alone, and posts no notice over it", async () => {
		// First writer wins. A person pressing Terminate backfills
		// `operator_terminated` while the abort is still cascading; this pass must
		// not relabel that as something the instance did, nor tell the thread the
		// work was abandoned when somebody chose to stop it.
		await clearRuns();
		const taskId = await createTask(teamId);
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
		await db.query('DELETE FROM task_comments WHERE task_id = $1', [taskId]);
		const runId = await insertQueuedRun('10 minutes', { taskId });
		await db.query('UPDATE heartbeat_runs SET cancel_reason = $1 WHERE id = $2', [
			RunCancelReason.OperatorTerminated,
			runId,
		]);

		expect(await detectOrphans(db, new Set())).toBe(1);

		const row = await db.query<{ cancel_reason: string | null }>(
			'SELECT cancel_reason FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(row.rows[0].cancel_reason).toBe(RunCancelReason.OperatorTerminated);
		expect(await abandonedNotices(taskId)).toBe(0);
	});

	it('the never-started chain actually climbs, lap by lap, to its ceiling', async () => {
		// The regression this exists for: the arm used to spend its strike on the
		// row it had just reaped and then hand the replacement a `previous_run_id`
		// lineage, which does NOT inherit the loss budget - so every lap started
		// back at zero and the ceiling was unreachable. Hand-setting the counter
		// (as the two tests below do) cannot see that; only driving real laps can.
		await clearRuns();
		await db.query('DELETE FROM approvals WHERE team_id = $1', [teamId]);
		const taskId = await createTask(teamId);
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const counts: number[] = [];
		let previousRunId: string | null = null;
		for (let lap = 0; lap < MAX_RETRIES; lap++) {
			// Each lap: the replacement wakeup from the previous lap becomes a run
			// that also never starts. `createHeartbeatRun` is what carries the budget
			// across, so the run must be minted the way production mints it.
			const wakeup = await db.query<{ id: string; payload: Record<string, unknown> }>(
				`SELECT id, payload FROM agent_wakeup_requests
				 WHERE member_id = $1 AND status = $2::wakeup_status`,
				[agentId, WakeupStatus.Queued],
			);
			const runId = await insertQueuedRun('10 minutes', {
				taskId,
				// Mirror createHeartbeatRun's inheritance rather than re-implementing
				// it: a lineage naming previous_failure.run_id carries the count.
				inheritFrom: lap === 0 ? null : previousRunId,
			});
			if (wakeup.rows[0]) {
				await db.query('UPDATE heartbeat_runs SET wakeup_id = $1 WHERE id = $2', [
					wakeup.rows[0].id,
					runId,
				]);
				await db.query(
					`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, claimed_at = now() WHERE id = $2`,
					[WakeupStatus.Failed, wakeup.rows[0].id],
				);
			}

			expect(await detectOrphans(db, new Set())).toBe(1);

			const after = await db.query<{ process_loss_retry_count: number }>(
				'SELECT process_loss_retry_count FROM heartbeat_runs WHERE id = $1',
				[runId],
			);
			counts.push(after.rows[0].process_loss_retry_count);
			previousRunId = runId;
		}

		// 1, 2, then the third lap trips the ceiling and gives up rather than
		// spending a fourth strike. Before the fix this was 1, 1, 1 - every lap
		// started back at zero, so the ceiling was never reached at all.
		expect(counts).toEqual([1, 2, 2]);

		// And the final lap gave up rather than queueing a fourth replacement.
		const queued = await db.query<{ id: string }>(
			`SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND status = $2::wakeup_status`,
			[agentId, WakeupStatus.Queued],
		);
		expect(queued.rows).toHaveLength(0);
		const approvals = await db.query<{ id: string }>(
			'SELECT id FROM approvals WHERE team_id = $1',
			[teamId],
		);
		expect(approvals.rows).toHaveLength(1);
	});

	it('gives up visibly once the never-started chain hits its ceiling', async () => {
		// The bound still exists, and it is now reachable only by spending strikes
		// this arm actually filled. What changed is that the give-up says so on the
		// row rather than claiming the work went back on the queue.
		await clearRuns();
		await db.query('DELETE FROM approvals WHERE team_id = $1', [teamId]);
		const taskId = await createTask(teamId);
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
		const runId = await insertQueuedRun('10 minutes', { taskId });
		await db.query('UPDATE heartbeat_runs SET process_loss_retry_count = 2 WHERE id = $1', [runId]);

		expect(await detectOrphans(db, new Set())).toBe(1);

		const queued = await db.query<{ id: string }>(
			`SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND status = $2::wakeup_status`,
			[agentId, WakeupStatus.Queued],
		);
		expect(queued.rows).toHaveLength(0);
		const approvals = await db.query<{ type: string }>(
			'SELECT type FROM approvals WHERE team_id = $1',
			[teamId],
		);
		expect(approvals.rows).toHaveLength(1);
		expect(approvals.rows[0].type).toBe(ApprovalType.Strategy);

		const run = await db.query<{ error: string }>(
			'SELECT error FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].error).toContain('will not restart on its own');
		expect(run.rows[0].error).not.toContain('back in the queue');
	});

	it('leaves a run alone that went terminal between the scan and the write', async () => {
		// The lost-update race. The scan sees a `running` row; by the time this pass
		// writes, the run's own driver has recorded the real cause. Unguarded, the
		// generic verdict replaced it and a strike was spent on a run that had
		// already reported itself.
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
		const runId = await insertOrphanRun(agentId, teamId, {});

		// Settle the row from underneath the pass, after its SELECT and before its
		// UPDATE, by hooking the query the scan itself makes.
		const racingDb = {
			...db,
			query: async (sql: string, params?: unknown[]) => {
				const res = await db.query(sql, params as never);
				if (sql.includes('FROM heartbeat_runs hr')) {
					await db.query(
						`UPDATE heartbeat_runs SET status = $1::heartbeat_run_status,
						   finished_at = now(), error = $2 WHERE id = $3`,
						[HeartbeatRunStatus.Failed, 'the real cause', runId],
					);
				}
				return res;
			},
		} as unknown as typeof db;

		expect(await detectOrphans(racingDb, new Set())).toBe(0);

		const row = await db.query<{ error: string; process_loss_retry_count: number }>(
			'SELECT error, process_loss_retry_count FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(row.rows[0].error).toBe('the real cause');
		expect(row.rows[0].process_loss_retry_count).toBe(0);
		const wakeups = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'reason' = 'orphan_retry'`,
			[agentId],
		);
		expect(wakeups.rows[0].c).toBe(0);
	});
});

/** Set an agent active with an updated_at older than the heal grace window.
 * The updated_at trigger overwrites explicit values, so it is suspended for
 * the backdating write. */
async function setAgentActiveStale(memberId: string): Promise<void> {
	await db.query('ALTER TABLE member_agents DISABLE TRIGGER trg_member_agents_updated');
	await db.query(
		`UPDATE member_agents
		 SET runtime_status = $1::agent_runtime_status, updated_at = now() - interval '10 minutes'
		 WHERE id = $2`,
		[AgentRuntimeStatus.Active, memberId],
	);
	await db.query('ALTER TABLE member_agents ENABLE TRIGGER trg_member_agents_updated');
}

describe('detectOrphans process reaping', () => {
	async function insertOrphanRunOnTask(taskId: string): Promise<string> {
		const result = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '10 minutes')
			 RETURNING id`,
			[teamId, agentId, taskId, HeartbeatRunStatus.Running],
		);
		return result.rows[0].id;
	}

	it("kills the orphaned run's in-container processes via the task's project container", async () => {
		const taskId = await createTask(teamId);
		const projectRow = await db.query<{ project_id: string }>(
			'SELECT project_id FROM tasks WHERE id = $1',
			[taskId],
		);
		await db.query(`UPDATE projects SET container_id = $1 WHERE id = $2`, [
			'orphan-container-1',
			projectRow.rows[0].project_id,
		]);
		const runId = await insertOrphanRunOnTask(taskId);

		const kills: Array<{ containerId: string; runId: string }> = [];
		await detectOrphans(db, new Set(), undefined, {
			killProcesses: async (containerId, rid) => {
				kills.push({ containerId, runId: rid });
			},
		});

		expect(kills).toContainEqual({ containerId: 'orphan-container-1', runId });
	});

	it('skips the kill for task-less runs (no container resolvable)', async () => {
		const runId = await insertOrphanRun(agentId, teamId);

		const kills: string[] = [];
		await detectOrphans(db, new Set(), undefined, {
			killProcesses: async (_cid, rid) => {
				kills.push(rid);
			},
		});

		expect(kills).not.toContain(runId);
		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
	});

	it('a kill failure does not fail detection', async () => {
		const taskId = await createTask(teamId);
		const projectRow = await db.query<{ project_id: string }>(
			'SELECT project_id FROM tasks WHERE id = $1',
			[taskId],
		);
		await db.query(`UPDATE projects SET container_id = $1 WHERE id = $2`, [
			'orphan-container-2',
			projectRow.rows[0].project_id,
		]);
		const runId = await insertOrphanRunOnTask(taskId);

		const count = await detectOrphans(db, new Set(), undefined, {
			killProcesses: async () => {
				throw new Error('daemon unreachable');
			},
		});

		expect(count).toBeGreaterThanOrEqual(1);
		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
	});
});

describe('healStaleRunState', () => {
	it('repairs lock, agent status, and claimed wakeup stranded by a lost completion path', async () => {
		await db.query(`DELETE FROM heartbeat_runs WHERE team_id = $1`, [teamId]);
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		// The exact stuck shape: wakeup claimed, run succeeded, lock never
		// released, agent never flipped back to idle.
		const taskId = await createTask(teamId);
		const wakeupRes = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, claimed_at, created_at)
			 VALUES ($1, $2, 'assignment', $3::wakeup_status, now() - interval '10 minutes', now() - interval '10 minutes')
			 RETURNING id`,
			[agentId, teamId, WakeupStatus.Claimed],
		);
		const wakeupId = wakeupRes.rows[0].id;
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, wakeup_id, status, started_at, finished_at, exit_code)
			 VALUES ($1, $2, $3, $4, $5::heartbeat_run_status, now() - interval '10 minutes', now() - interval '8 minutes', 0)`,
			[teamId, agentId, taskId, wakeupId, HeartbeatRunStatus.Succeeded],
		);
		const lockRes = await db.query<{ id: string }>(
			`INSERT INTO execution_locks (task_id, member_id, locked_at) VALUES ($1, $2, now() - interval '10 minutes') RETURNING id`,
			[taskId, agentId],
		);
		await setAgentActiveStale(agentId);

		await healStaleRunState(db);

		const lock = await db.query<{ released_at: string | null }>(
			'SELECT released_at FROM execution_locks WHERE id = $1',
			[lockRes.rows[0].id],
		);
		expect(lock.rows[0].released_at).not.toBeNull();

		const agent = await db.query<{ runtime_status: string; last_heartbeat_at: string | null }>(
			'SELECT runtime_status, last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);
		expect(agent.rows[0].last_heartbeat_at).not.toBeNull();

		const wakeup = await db.query<{ status: string; completed_at: string | null }>(
			'SELECT status, completed_at FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(wakeup.rows[0].status).toBe(WakeupStatus.Completed);
		expect(wakeup.rows[0].completed_at).not.toBeNull();
	});

	it('marks a stale claimed wakeup failed when its run failed', async () => {
		await db.query(`DELETE FROM heartbeat_runs WHERE team_id = $1`, [teamId]);
		const wakeupRes = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, claimed_at, created_at)
			 VALUES ($1, $2, 'assignment', $3::wakeup_status, now() - interval '10 minutes', now() - interval '10 minutes')
			 RETURNING id`,
			[agentId, teamId, WakeupStatus.Claimed],
		);
		const wakeupId = wakeupRes.rows[0].id;
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, wakeup_id, status, started_at, finished_at, exit_code)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '10 minutes', now() - interval '8 minutes', 1)`,
			[teamId, agentId, wakeupId, HeartbeatRunStatus.Failed],
		);

		await healStaleRunState(db);

		const wakeup = await db.query<{ status: string }>(
			'SELECT status FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(wakeup.rows[0].status).toBe(WakeupStatus.Failed);
	});

	it('requeues a stale claimed wakeup whose run never materialized', async () => {
		await db.query(`DELETE FROM heartbeat_runs WHERE team_id = $1`, [teamId]);
		const wakeupRes = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, claimed_at, created_at)
			 VALUES ($1, $2, 'assignment', $3::wakeup_status, now() - interval '10 minutes', now() - interval '10 minutes')
			 RETURNING id`,
			[agentId, teamId, WakeupStatus.Claimed],
		);
		const wakeupId = wakeupRes.rows[0].id;

		await healStaleRunState(db);

		const wakeup = await db.query<{ status: string; claimed_at: string | null }>(
			'SELECT status, claimed_at FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(wakeup.rows[0].status).toBe(WakeupStatus.Queued);
		expect(wakeup.rows[0].claimed_at).toBeNull();
	});

	it('leaves fresh dispatch state and live runs untouched', async () => {
		await db.query(`DELETE FROM heartbeat_runs WHERE team_id = $1`, [teamId]);
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		// Fresh dispatch: everything just happened — inside the grace window.
		const taskId = await createTask(teamId);
		const wakeupRes = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, claimed_at, created_at)
			 VALUES ($1, $2, 'assignment', $3::wakeup_status, now(), now())
			 RETURNING id`,
			[agentId, teamId, WakeupStatus.Claimed],
		);
		const lockRes = await db.query<{ id: string }>(
			`INSERT INTO execution_locks (task_id, member_id) VALUES ($1, $2) RETURNING id`,
			[taskId, agentId],
		);
		await setAgentActive(agentId);

		await healStaleRunState(db);

		const lock = await db.query<{ released_at: string | null }>(
			'SELECT released_at FROM execution_locks WHERE id = $1',
			[lockRes.rows[0].id],
		);
		expect(lock.rows[0].released_at).toBeNull();
		const agent = await db.query<{ runtime_status: string }>(
			'SELECT runtime_status FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Active);
		const wakeup = await db.query<{ status: string }>(
			'SELECT status FROM agent_wakeup_requests WHERE id = $1',
			[wakeupRes.rows[0].id],
		);
		expect(wakeup.rows[0].status).toBe(WakeupStatus.Claimed);

		// Old state backed by a live (running) run also stays untouched.
		await db.query(
			`UPDATE agent_wakeup_requests SET claimed_at = now() - interval '10 minutes' WHERE id = $1`,
			[wakeupRes.rows[0].id],
		);
		await db.query(
			`UPDATE execution_locks SET locked_at = now() - interval '10 minutes' WHERE id = $1`,
			[lockRes.rows[0].id],
		);
		await setAgentActiveStale(agentId);
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, wakeup_id, status, started_at)
			 VALUES ($1, $2, $3, $4, $5::heartbeat_run_status, now() - interval '10 minutes')`,
			[teamId, agentId, taskId, wakeupRes.rows[0].id, HeartbeatRunStatus.Running],
		);

		await healStaleRunState(db);

		const lock2 = await db.query<{ released_at: string | null }>(
			'SELECT released_at FROM execution_locks WHERE id = $1',
			[lockRes.rows[0].id],
		);
		expect(lock2.rows[0].released_at).toBeNull();
		const agent2 = await db.query<{ runtime_status: string }>(
			'SELECT runtime_status FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(agent2.rows[0].runtime_status).toBe(AgentRuntimeStatus.Active);
		const wakeup2 = await db.query<{ status: string }>(
			'SELECT status FROM agent_wakeup_requests WHERE id = $1',
			[wakeupRes.rows[0].id],
		);
		expect(wakeup2.rows[0].status).toBe(WakeupStatus.Claimed);

		await db.query(`DELETE FROM heartbeat_runs WHERE team_id = $1`, [teamId]);
		await db.query(
			'UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2',
			[AgentRuntimeStatus.Idle, agentId],
		);
	});
});
