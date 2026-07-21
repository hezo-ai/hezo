import {
	AgentRuntimeStatus,
	ApprovalType,
	HeartbeatRunStatus,
	WakeupSource,
	WakeupStatus,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { detectOrphans, healStaleRunState } from '../src/services/orphan-detector';
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
	const teamTemplateId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

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
		// Clean state — no running heartbeat runs
		await db.query(
			`DELETE FROM heartbeat_runs WHERE team_id = $1 AND status = $2::heartbeat_run_status`,
			[teamId, HeartbeatRunStatus.Running],
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
			`DELETE FROM heartbeat_runs WHERE team_id = $1 AND status = $2::heartbeat_run_status`,
			[teamId, HeartbeatRunStatus.Running],
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
		// Remove all existing running runs
		await db.query(
			`DELETE FROM heartbeat_runs WHERE team_id = $1 AND status = $2::heartbeat_run_status`,
			[teamId, HeartbeatRunStatus.Running],
		);

		// Insert 3 orphaned runs (no PIDs)
		await insertOrphanRun(agentId, teamId);
		await insertOrphanRun(agentId, teamId);
		await insertOrphanRun(agentId, teamId);

		const count = await detectOrphans(db, new Set());
		expect(count).toBe(3);
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
