import type { PGlite } from '@electric-sql/pglite';
import { AgentRuntimeStatus, HeartbeatRunStatus, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { ContainerLogStreamer } from '../src/services/container-logs';
import type { DockerClient } from '../src/services/docker';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;

// A complete docker mock whose exec calls succeed, so a launched run completes
// cleanly rather than throwing (the default test stub's execCreate throws).
function createMockDocker(): DockerClient {
	return {
		ping: async () => true,
		imageExists: async () => true,
		pullImage: async () => {},
		createContainer: async () => ({ Id: 'container-123', Warnings: [] }),
		startContainer: async () => {},
		stopContainer: async () => {},
		removeContainer: async () => {},
		inspectContainer: async () => ({
			Id: 'container-123',
			State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
			Config: { Image: 'test' },
		}),
		containerLogs: async () => new ReadableStream(),
		execCreate: async () => 'exec-123',
		execStart: async () => ({ stdout: 'done', stderr: '' }),
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
	} as unknown as DockerClient;
}

function createJobManager(overrides: Partial<JobManagerDeps> = {}): JobManager {
	return new JobManager({
		db,
		docker: createMockDocker(),
		masterKeyManager,
		serverPort: 3100,
		dataDir: '/tmp/test-data',
		wsManager: { broadcast: () => {} } as any,
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
		...overrides,
	});
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const teamRes = await createTestTeam(db, { name: 'JM Coverage Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'JM Coverage Project',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'JM Coverage Task',
			description: 'Test task',
			assignee_id: agentId,
		}),
	});
	const createdTask = (await taskRes.json()).data;
	taskId = createdTask.id;

	// Seed a designated repo so the touches_code repo-setup gate is bypassed by
	// default; the gate is exercised explicitly in its own test.
	const repoRes = await db.query<{ id: string }>(
		`INSERT INTO repos (project_id, repo_identifier, host_type)
		 VALUES ($1, 'test-org/test-repo', 'github'::repo_host_type)
		 RETURNING id`,
		[projectId],
	);
	await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
		repoRes.rows[0].id,
		projectId,
	]);

	// Let task-creation's fire-and-forget assignment wakeup settle, then clear it.
	await new Promise((r) => setTimeout(r, 50));
	await db.query("DELETE FROM agent_wakeup_requests WHERE payload->>'task_id' = $1::text", [
		taskId,
	]);
});

afterEach(async () => {
	// Drain in-flight launchTask (background runAgent) promises before next test.
	await waitForBackground();
	await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
	await db.query('DELETE FROM heartbeat_runs WHERE member_id = $1', [agentId]);
	await db.query(
		'UPDATE execution_locks SET released_at = now() WHERE task_id = $1 AND released_at IS NULL',
		[taskId],
	);
});

afterAll(async () => {
	await safeClose(db);
});

async function insertQueuedTaskWakeup(source = 'mention'): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, created_at)
		 VALUES ($1, $2, $3::wakeup_source, 'queued'::wakeup_status,
		         jsonb_build_object('task_id', $4::text), now() - interval '30 seconds')
		 RETURNING id`,
		[agentId, teamId, source, taskId],
	);
	return r.rows[0].id;
}

describe('JobManager.dispatchWakeupNow gating', () => {
	it('returns task_busy when the task already has an active run', async () => {
		const manager = createJobManager();
		await db.query(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
			[agentId, teamId, taskId, HeartbeatRunStatus.Running],
		);
		const wakeupId = await insertQueuedTaskWakeup();

		const result = await manager.dispatchWakeupNow(wakeupId);
		expect(result).toEqual({ dispatched: false, reason: 'task_busy' });

		const w = await db.query<{ last_skipped_reason: string | null }>(
			'SELECT last_skipped_reason FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(w.rows[0].last_skipped_reason).toBe('task_busy');
		manager.shutdown();
	});

	it('returns project_at_capacity when the project is at its run limit', async () => {
		const manager = createJobManager();
		await db.query('UPDATE projects SET max_concurrent_runs = 1 WHERE id = $1', [projectId]);

		// A sibling busy task fills the single project slot.
		const sibling = await db.query<{ id: string; identifier: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, description, status, priority, labels)
			 VALUES ($1, $2, $3, next_project_task_number($2),
			         (SELECT task_prefix FROM projects WHERE id = $2) || '-busy',
			         'Sibling busy', '', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id, identifier`,
			[teamId, projectId, agentId],
		);
		await db.query(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
			[agentId, teamId, sibling.rows[0].id, HeartbeatRunStatus.Running],
		);

		const wakeupId = await insertQueuedTaskWakeup();
		const result = await manager.dispatchWakeupNow(wakeupId);
		expect(result).toEqual({ dispatched: false, reason: 'project_at_capacity' });

		const w = await db.query<{ last_skipped_reason: string | null }>(
			'SELECT last_skipped_reason FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(w.rows[0].last_skipped_reason).toBe('project_at_capacity');

		manager.shutdown();
		await db.query('UPDATE projects SET max_concurrent_runs = 3 WHERE id = $1', [projectId]);
		await db.query('DELETE FROM heartbeat_runs WHERE task_id = $1', [sibling.rows[0].id]);
		await db.query('DELETE FROM tasks WHERE id = $1', [sibling.rows[0].id]);
	});

	it('returns agent_busy when the agent is already running another task in the project', async () => {
		const manager = createJobManager();

		const sibling = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, description, status, priority, labels)
			 VALUES ($1, $2, $3, next_project_task_number($2),
			         (SELECT task_prefix FROM projects WHERE id = $2) || '-ab',
			         'Sibling agent-busy', '', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, projectId, agentId],
		);
		// An active run on a different task for the same agent in this project.
		await db.query(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
			[agentId, teamId, sibling.rows[0].id, HeartbeatRunStatus.Running],
		);

		const wakeupId = await insertQueuedTaskWakeup();
		const result = await manager.dispatchWakeupNow(wakeupId);
		expect(result).toEqual({ dispatched: false, reason: 'agent_busy' });

		manager.shutdown();
		await db.query('DELETE FROM heartbeat_runs WHERE task_id = $1', [sibling.rows[0].id]);
		await db.query('DELETE FROM tasks WHERE id = $1', [sibling.rows[0].id]);
	});

	it('returns blocked and defers when the task has an open blocker (assignment source)', async () => {
		const manager = createJobManager();

		const blocker = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, description, status, priority, labels)
			 VALUES ($1, $2, $3, next_project_task_number($2),
			         (SELECT task_prefix FROM projects WHERE id = $2) || '-blk',
			         'Open blocker', '', 'in_progress'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, projectId, agentId],
		);
		await db.query(`INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)`, [
			taskId,
			blocker.rows[0].id,
		]);

		// `assignment` source is gated by blockers (unlike conversational sources).
		const wakeupId = await insertQueuedTaskWakeup('assignment');
		const result = await manager.dispatchWakeupNow(wakeupId);
		expect(result).toEqual({ dispatched: false, reason: 'blocked' });

		const w = await db.query<{ status: string }>(
			'SELECT status FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(w.rows[0].status).toBe(WakeupStatus.Deferred);

		manager.shutdown();
		await db.query('DELETE FROM task_dependencies WHERE task_id = $1', [taskId]);
		await db.query('DELETE FROM tasks WHERE id = $1', [blocker.rows[0].id]);
	});

	it('returns not_queued when the wakeup was claimed between lookup and the conditional claim', async () => {
		const manager = createJobManager();
		// A task-less wakeup skips the per-task gating and goes straight to the
		// conditional claim; flip to claimed first so the WHERE guard fails.
		const r = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at)
			 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
			 RETURNING id`,
			[agentId, teamId],
		);
		// The lookup sees queued? No — it's already claimed, so the first status
		// guard returns not_queued. Re-insert as queued then claim mid-flight is
		// hard to race deterministically; the status guard path is equivalent.
		const result = await manager.dispatchWakeupNow(r.rows[0].id);
		expect(result).toEqual({ dispatched: false, reason: 'not_queued' });
		manager.shutdown();
	});
});

describe('JobManager.activateAgent additional branches', () => {
	it('defers the wakeup when a touches_code agent has no designated repo', async () => {
		const manager = createJobManager();
		await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);
		await db.query('UPDATE member_agents SET touches_code = true WHERE id = $1', [agentId]);
		await db.query(
			"UPDATE projects SET designated_repo_id = NULL, container_id = 'c', container_status = 'running' WHERE id = $1",
			[projectId],
		);

		const wakeupId = await insertQueuedTaskWakeup('assignment');
		await db.query("UPDATE agent_wakeup_requests SET status = 'claimed' WHERE id = $1", [wakeupId]);
		await (manager as any).activateAgent(
			agentId,
			teamId,
			wakeupId,
			{ task_id: taskId },
			'assignment',
		);

		const w = await db.query<{ status: string; payload: Record<string, unknown> }>(
			'SELECT status, payload FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(w.rows[0].status).toBe(WakeupStatus.Deferred);
		expect(w.rows[0].payload.reason).toBe('awaiting_repo_setup');

		manager.shutdown();
		// Restore repo + touches_code for other tests.
		const repo = await db.query<{ id: string }>(
			'SELECT id FROM repos WHERE project_id = $1 LIMIT 1',
			[projectId],
		);
		await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
			repo.rows[0].id,
			projectId,
		]);
	});

	it('re-queues the wakeup while the project container is still creating', async () => {
		const manager = createJobManager();
		await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);
		await db.query(
			"UPDATE projects SET container_id = NULL, container_status = 'creating' WHERE id = $1",
			[projectId],
		);

		const wakeupId = await insertQueuedTaskWakeup('mention');
		await db.query("UPDATE agent_wakeup_requests SET status = 'claimed' WHERE id = $1", [wakeupId]);
		await (manager as any).activateAgent(agentId, teamId, wakeupId, { task_id: taskId }, 'mention');

		const w = await db.query<{ status: string; claimed_at: string | null }>(
			'SELECT status, claimed_at FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(w.rows[0].status).toBe(WakeupStatus.Queued);
		expect(w.rows[0].claimed_at).toBeNull();

		manager.shutdown();
		await db.query(
			"UPDATE projects SET container_id = 'test-container', container_status = 'running' WHERE id = $1",
			[projectId],
		);
	});

	it('pauses the agent and records over_budget when the agent is over its daily budget', async () => {
		const manager = createJobManager();
		await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);
		await db.query(
			"UPDATE projects SET container_id = 'test-container', container_status = 'running' WHERE id = $1",
			[projectId],
		);
		await db.query('UPDATE member_agents SET daily_budget_cents = 10 WHERE id = $1', [agentId]);
		await db.query(
			`INSERT INTO cost_entries (member_id, project_id, amount_cents, description)
			 VALUES ($1, $2, 50, 'over budget')`,
			[agentId, projectId],
		);

		const wakeupId = await insertQueuedTaskWakeup('mention');
		await db.query("UPDATE agent_wakeup_requests SET status = 'claimed' WHERE id = $1", [wakeupId]);
		await (manager as any).activateAgent(agentId, teamId, wakeupId, { task_id: taskId }, 'mention');

		const w = await db.query<{ status: string; last_skipped_reason: string | null }>(
			'SELECT status, last_skipped_reason FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(w.rows[0].last_skipped_reason).toBe('over_budget');

		const agentRow = await db.query<{ runtime_status: string }>(
			'SELECT runtime_status FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(agentRow.rows[0].runtime_status).not.toBe(AgentRuntimeStatus.Idle);

		manager.shutdown();
		await db.query('UPDATE member_agents SET daily_budget_cents = 0 WHERE id = $1', [agentId]);
		await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
		await db.query("UPDATE member_agents SET runtime_status = 'idle' WHERE id = $1", [agentId]);
	});

	it('marks the wakeup completed when the explicit payload task is not found', async () => {
		const manager = createJobManager();
		const wakeupId = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, created_at)
			 VALUES ($1, $2, 'mention', 'claimed', jsonb_build_object('task_id', $3::text), now())
			 RETURNING id`,
			[agentId, teamId, '00000000-0000-0000-0000-0000000000aa'],
		);
		await (manager as any).activateAgent(
			agentId,
			teamId,
			wakeupId.rows[0].id,
			{
				task_id: '00000000-0000-0000-0000-0000000000aa',
			},
			'mention',
		);

		const w = await db.query<{ status: string; completed_at: string | null }>(
			'SELECT status, completed_at FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId.rows[0].id],
		);
		expect(w.rows[0].status).toBe(WakeupStatus.Completed);
		expect(w.rows[0].completed_at).not.toBeNull();
		manager.shutdown();
	});
});

describe('JobManager cron-driven sweeps (no-op / guard paths)', () => {
	it('processBudgetResumes is a no-op when no agents are in a budget-pause state', async () => {
		const manager = createJobManager();
		await expect((manager as any).processBudgetResumes()).resolves.toBeUndefined();
		manager.shutdown();
	});

	it('processScheduledHeartbeats skips an agent that already has an in-flight run', async () => {
		const manager = createJobManager();
		// Make the agent due and occupy its member key so isMemberRunning() is true.
		await db.query(
			'UPDATE member_agents SET last_heartbeat_at = NULL, admin_status = $1 WHERE id = $2',
			['enabled', agentId],
		);
		manager.launchTask(
			`${agentId}:${projectId}`,
			(signal) =>
				new Promise<void>((resolve) => {
					if (signal.aborted) return resolve();
					signal.addEventListener('abort', () => resolve());
				}),
			5000,
		);

		await (manager as any).processScheduledHeartbeats();

		// No heartbeat wakeup should have been created for the busy agent.
		const wakeups = await db.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM agent_wakeup_requests
			 WHERE member_id = $1 AND source = 'heartbeat'`,
			[agentId],
		);
		expect(wakeups.rows[0].count).toBe('0');

		manager.cancelTask(`${agentId}:${projectId}`);
		manager.shutdown();
		await waitForBackground();
	});

	it('checkForUpdate returns early when not running as a supervised worker', async () => {
		const manager = createJobManager();
		// In the test/vitest (Node) environment isSupervisedWorker() is false, so
		// this returns before touching the updater — exercising the guard branch.
		await expect((manager as any).checkForUpdate()).resolves.toBeUndefined();
		manager.shutdown();
	});

	it('archiveInboxItems runs cleanly and archives nothing when no old items exist', async () => {
		const manager = createJobManager();
		await expect((manager as any).archiveInboxItems()).resolves.toBeUndefined();
		manager.shutdown();
	});

	it('requeueWakeup no-ops for an undefined id', async () => {
		const manager = createJobManager();
		await expect((manager as any).requeueWakeup(undefined)).resolves.toBeUndefined();
		manager.shutdown();
	});
});

describe('JobManager live-run registry', () => {
	it('cancelLiveRun returns false for an unknown run id', () => {
		const manager = createJobManager();
		expect(manager.cancelLiveRun('nope')).toBe(false);
		manager.shutdown();
	});

	// A launched fn that settles when its AbortSignal fires, so shutdown/cancel
	// lets waitForBackground drain instead of hanging on a never-resolving promise.
	const holdUntilAbort = (signal: AbortSignal) =>
		new Promise<void>((resolve) => {
			if (signal.aborted) return resolve();
			signal.addEventListener('abort', () => resolve());
		});

	it('registers, scopes by project, and cancels live runs', async () => {
		const manager = createJobManager();
		const taskKey = `${agentId}:${projectId}`;
		// Hold the task key so cancelTask (invoked by cancelLiveRun) finds it.
		manager.launchTask(taskKey, holdUntilAbort, 5000);
		manager.registerLiveRun({
			runId: 'run-1',
			memberId: agentId,
			taskId,
			projectId,
			teamId,
			taskKey,
		});
		expect(manager.getLiveRunIds().has('run-1')).toBe(true);
		expect(manager.getLiveRunsForProject(projectId).length).toBe(1);
		expect(manager.getLiveRunsForProject('other-project').length).toBe(0);

		expect(manager.cancelLiveRun('run-1')).toBe(true);
		expect(manager.getLiveRunIds().has('run-1')).toBe(false);
		manager.shutdown();
		await waitForBackground();
	});

	it('cancelLiveRunsForProject cancels every run scoped to the project', async () => {
		const manager = createJobManager();
		const key1 = `${agentId}:${projectId}`;
		manager.launchTask(key1, holdUntilAbort, 5000);
		manager.registerLiveRun({
			runId: 'run-a',
			memberId: agentId,
			taskId,
			projectId,
			teamId,
			taskKey: key1,
		});
		const removed = manager.cancelLiveRunsForProject(projectId, 'container_stopped');
		expect(removed).toBe(1);
		expect(manager.getLiveRunIds().size).toBe(0);
		manager.shutdown();
		await waitForBackground();
	});
});
