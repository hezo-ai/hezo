import { AgentRuntimeStatus, HeartbeatRunStatus, TaskStatus, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';
import {
	clearContainerCapacityForTest,
	removeSeededContainerProject,
	seedRunningContainerProject,
	setContainerCapacityForTest,
} from './helpers/capacity';

// The runner's data dir must be the harness's own, not a fixed path: the
// container engine resolves a run's files through the project's workspace under
// it, so a hardcoded literal would stage them somewhere the test cannot read.
let testDataDir: string;
let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let taskIdentifier: string;
let agentId: string;

function createMockDocker(): ContainerEngine {
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
		killRunProcesses: async () => {},
	} as unknown as ContainerEngine;
}

function createJobManager(overrides: Partial<JobManagerDeps> = {}): JobManager {
	return new JobManager({
		db,
		docker: createMockDocker(),
		masterKeyManager,
		serverPort: 3100,
		dataDir: testDataDir,
		wsManager: { broadcast: () => {} } as any,
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
		...overrides,
	});
}

beforeAll(async () => {
	const ctx = await createTestApp();
	testDataDir = ctx.dataDir;
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;

	const teamRes = await createTestTeam(db, { name: 'Workflow Test Co', template_id: typeId });
	const team = (await teamRes.json()).data;
	teamId = team.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Workflow Test Project',
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
			title: 'Workflow Test Task',
			description: 'Test task for workflow testing',
			assignee_id: agentId,
		}),
	});
	const createdTask = (await taskRes.json()).data;
	taskId = createdTask.id;
	taskIdentifier = createdTask.identifier;

	// These tests focus on wakeup/lock lifecycle, not the designated-repo gate.
	// Seed a designated repo on the project so the gate short-circuit is bypassed.
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
});

afterEach(async () => {
	// Drain any in-flight launchTask promises from this test (background
	// runAgent invocations) before the next test runs. Without this, those
	// promises issue queries on the shared PGlite connection concurrently
	// with the next test's setup — and because PGlite is single-connection,
	// a BEGIN started by the background task captures the next test's
	// queries, so a downstream FK violation aborts the wrong transaction.
	await waitForBackground();
});

afterAll(async () => {
	await safeClose(db);
});

/**
 * "This project has no running container" - both representations of it.
 *
 * A project row and its pool members are two records of the same containers, so
 * a fixture that stops only the row leaves the pool advertising a warm container
 * the capacity gate will happily let a run take.
 */
async function stopProjectContainers(db: Db, projectId: string): Promise<void> {
	await db.query(`UPDATE projects SET container_status = 'stopped' WHERE id = $1`, [projectId]);
	await db.query(`UPDATE container_pool_members SET state = 'suspended' WHERE project_id = $1`, [
		projectId,
	]);
}

async function startProjectContainers(db: Db, projectId: string): Promise<void> {
	await db.query(`UPDATE projects SET container_status = 'running' WHERE id = $1`, [projectId]);
	await db.query(`UPDATE container_pool_members SET state = 'idle' WHERE project_id = $1`, [
		projectId,
	]);
}

describe('JobManager workflow methods', () => {
	describe('processWakeups', () => {
		it('skips wakeups that are too recent (within coalescing window)', async () => {
			const manager = createJobManager();

			// Insert a wakeup with created_at = now() (within the 10s coalescing window)
			await db.query(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'queued', now())`,
				[agentId, teamId],
			);

			await (manager as any).processWakeups();

			// Should still be queued since it's too recent
			const result = await db.query<{ status: string }>(
				`SELECT status FROM agent_wakeup_requests
				 WHERE member_id = $1 AND team_id = $2
				   AND source = 'on_demand'
				 ORDER BY created_at DESC LIMIT 1`,
				[agentId, teamId],
			);
			expect(result.rows[0].status).toBe(WakeupStatus.Queued);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1 AND team_id = $2', [
				agentId,
				teamId,
			]);
		});

		it('claims old queued wakeups and advances their status', async () => {
			const manager = createJobManager();

			// Insert a wakeup created 30 seconds ago (past the coalescing window)
			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'queued', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).processWakeups();

			const result = await db.query<{ status: string; claimed_at: string | null }>(
				'SELECT status, claimed_at FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);

			// The wakeup should have been claimed (status changed from queued)
			expect(result.rows[0].status).not.toBe(WakeupStatus.Queued);
			// claimed_at should be set when it was claimed
			expect(result.rows[0].claimed_at).not.toBeNull();

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		});

		it('records instance_at_capacity on a task wakeup when the container limit is reached', async () => {
			const manager = createJobManager();
			// Container semantics: the wakeup's project container is stopped and a
			// filler project's running container consumes the single slot.
			await setContainerCapacityForTest(db, 1);
			await stopProjectContainers(db, projectId);
			await seedRunningContainerProject(db, 'cap-filler-wakeups');

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests
				   (member_id, team_id, source, status, payload, created_at)
				 VALUES ($1, $2, 'assignment', 'queued', $3::jsonb, now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId, JSON.stringify({ task_id: taskId, reason: 'unblocked' })],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).processWakeups();

			const wakeup = await db.query<{
				status: string;
				last_skipped_reason: string | null;
				last_skipped_blocker_task_id: string | null;
			}>(
				`SELECT status, last_skipped_reason, last_skipped_blocker_task_id
				 FROM agent_wakeup_requests WHERE id = $1`,
				[wakeupId],
			);
			expect(wakeup.rows[0].status).toBe(WakeupStatus.Queued);
			expect(wakeup.rows[0].last_skipped_reason).toBe('instance_at_capacity');
			expect(wakeup.rows[0].last_skipped_blocker_task_id).toBeNull();

			const taskRes = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}`, {
				headers: authHeader(token),
			});
			const task = (await taskRes.json()).data as {
				queued_wakeup: {
					reason: string;
					blocker_identifier: string | null;
				} | null;
			};
			expect(task.queued_wakeup).not.toBeNull();
			expect(task.queued_wakeup?.reason).toBe('instance_at_capacity');

			manager.shutdown();
			await startProjectContainers(db, projectId);
			await removeSeededContainerProject(db, 'cap-filler-wakeups');
			await clearContainerCapacityForTest(db);
			// Drain everything still queued: the capacity block skipped not just our
			// wakeup but any background ones (task-assignment pings), which earlier
			// tests used to leave settled — later tests assume none are pending.
			await db.query(`DELETE FROM agent_wakeup_requests WHERE team_id = $1 AND status = 'queued'`, [
				teamId,
			]);
		});

		it('clears last_skipped_* state when a wakeup is finally claimed', async () => {
			const manager = createJobManager();

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests
				   (member_id, team_id, source, status, payload, last_skipped_at,
				    last_skipped_reason, created_at)
				 VALUES ($1, $2, 'assignment', 'queued', $3::jsonb, now(),
				         'project_at_capacity', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId, JSON.stringify({ task_id: taskId, reason: 'unblocked' })],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).processWakeups();

			const wakeup = await db.query<{
				status: string;
				last_skipped_reason: string | null;
			}>(`SELECT status, last_skipped_reason FROM agent_wakeup_requests WHERE id = $1`, [wakeupId]);
			expect(wakeup.rows[0].status).not.toBe(WakeupStatus.Queued);
			expect(wakeup.rows[0].last_skipped_reason).toBeNull();

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		});

		it('re-queues a task wakeup while the project container is still provisioning', async () => {
			const manager = createJobManager();
			// Provisioning in flight: container_id stays NULL until the container
			// reaches running, and status is 'creating'.
			await db.query(
				`UPDATE projects SET container_status = 'creating'::container_status, container_id = NULL WHERE id = $1`,
				[projectId],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests
				   (member_id, team_id, source, status, payload, created_at)
				 VALUES ($1, $2, 'assignment', 'queued', $3::jsonb, now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId, JSON.stringify({ task_id: taskId })],
			);
			const wakeupId = wakeupRes.rows[0].id;

			const runsBefore = await db.query<{ count: string }>(
				'SELECT count(*)::text AS count FROM heartbeat_runs WHERE task_id = $1',
				[taskId],
			);

			await (manager as any).processWakeups();

			// The wakeup is returned to the queue (not failed) so it retries once the
			// container is running, and no run was started in the meantime.
			const wakeup = await db.query<{ status: string; claimed_at: string | null }>(
				'SELECT status, claimed_at FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(wakeup.rows[0].status).toBe(WakeupStatus.Queued);
			expect(wakeup.rows[0].claimed_at).toBeNull();

			const runs = await db.query<{ count: string }>(
				'SELECT count(*)::text AS count FROM heartbeat_runs WHERE task_id = $1',
				[taskId],
			);
			expect(runs.rows[0].count).toBe(runsBefore.rows[0].count);

			manager.shutdown();
			await db.query(
				`UPDATE projects SET container_status = NULL, container_id = NULL WHERE id = $1`,
				[projectId],
			);
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		});

		it('skips agents that already have a running task', async () => {
			const manager = createJobManager();

			// Simulate a running task for this agent (project-scoped key matches activateAgent)
			manager.launchTask(
				`${agentId}:${projectId}`,
				async () => {
					await new Promise((r) => setTimeout(r, 5000));
				},
				10_000,
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'queued', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).processWakeups();

			// Still queued because the agent's task is already running
			const result = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(result.rows[0].status).toBe(WakeupStatus.Queued);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		});
	});

	describe('activateAgent', () => {
		it('marks wakeup as skipped when agent does not exist', async () => {
			const manager = createJobManager();

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			// Use a non-existent member ID
			const fakeId = '00000000-0000-0000-0000-000000000001';
			await (manager as any).activateAgent(fakeId, teamId, wakeupId);

			const result = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(result.rows[0].status).toBe(WakeupStatus.Skipped);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		});

		it('marks wakeup as skipped when agent is disabled', async () => {
			const manager = createJobManager();

			// Disable the agent
			await db.query("UPDATE member_agents SET admin_status = 'disabled' WHERE id = $1", [agentId]);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).activateAgent(agentId, teamId, wakeupId);

			const result = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(result.rows[0].status).toBe(WakeupStatus.Skipped);

			// Re-enable the agent for subsequent tests
			await db.query("UPDATE member_agents SET admin_status = 'enabled' WHERE id = $1", [agentId]);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		});

		it('marks wakeup completed and advances last_heartbeat_at when agent has no assigned tasks', async () => {
			const manager = createJobManager();

			// Ensure agent has no open tasks assigned to it
			await db.query(
				"UPDATE tasks SET assignee_id = NULL WHERE assignee_id = $1 AND status NOT IN ('done', 'cancelled')",
				[agentId],
			);
			// A never-heartbeated agent is perpetually "due"; the no-op scan must stamp
			// last_heartbeat_at so the scheduler throttles instead of re-firing each tick.
			await db.query('UPDATE member_agents SET last_heartbeat_at = NULL WHERE id = $1', [agentId]);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).activateAgent(agentId, teamId, wakeupId);

			const result = await db.query<{ status: string; completed_at: string | null }>(
				'SELECT status, completed_at FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(result.rows[0].status).toBe(WakeupStatus.Completed);
			expect(result.rows[0].completed_at).not.toBeNull();

			const agentRow = await db.query<{ last_heartbeat_at: string | null }>(
				'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
				[agentId],
			);
			expect(agentRow.rows[0].last_heartbeat_at).not.toBeNull();

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		});

		it('launches (lazy-starting the container) when the project has no container', async () => {
			const manager = createJobManager();

			// Assign the task to the agent (project has no container_id yet)
			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);

			// No container at all: the old code failed the wakeup here; with
			// lazy-start the activation falls through and launches — the runner
			// provisions the container as part of the run.
			await db.query(
				'UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1',
				[projectId],
			);

			const runsBefore = await db.query<{ count: string }>(
				'SELECT count(*)::text AS count FROM heartbeat_runs WHERE task_id = $1',
				[taskId],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).activateAgent(agentId, teamId, wakeupId);
			await waitForBackground();

			// The old fast-path failed the wakeup WITHOUT ever creating a run. The
			// proof of lazy-start is that a real run row exists — under the stub
			// docker its provision then fails, which is the run's own outcome (and
			// what a real deployment would surface on the task), not a dispatch
			// refusal.
			const runsAfter = await db.query<{ count: string }>(
				'SELECT count(*)::text AS count FROM heartbeat_runs WHERE task_id = $1',
				[taskId],
			);
			expect(Number(runsAfter.rows[0].count)).toBeGreaterThan(Number(runsBefore.rows[0].count));

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
			await db.query('DELETE FROM heartbeat_runs WHERE task_id = $1', [taskId]);
			await db.query(
				`UPDATE projects SET container_id = 'test-container', container_status = 'running' WHERE id = $1`,
				[projectId],
			);
			await db.query('UPDATE execution_locks SET released_at = now() WHERE released_at IS NULL');
		});

		it('creates an execution lock and launches a task when project has container', async () => {
			const manager = createJobManager();

			// Assign the task to the agent
			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);

			// Give the project a container
			await db.query(
				"UPDATE projects SET container_id = 'test-container-id', container_status = 'running' WHERE id = $1",
				[projectId],
			);

			// Release any existing execution lock for this pair
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE task_id = $1 AND member_id = $2 AND released_at IS NULL',
				[taskId, agentId],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).activateAgent(agentId, teamId, wakeupId);

			// An execution lock should have been created
			const lockResult = await db.query<{ task_id: string; member_id: string }>(
				'SELECT task_id, member_id FROM execution_locks WHERE task_id = $1 AND member_id = $2',
				[taskId, agentId],
			);
			expect(lockResult.rows.length).toBeGreaterThan(0);
			expect(lockResult.rows[lockResult.rows.length - 1].task_id).toBe(taskId);
			expect(lockResult.rows[lockResult.rows.length - 1].member_id).toBe(agentId);

			// A task should have been launched for the agent
			expect(manager.isMemberRunning(agentId)).toBe(true);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE task_id = $1 AND member_id = $2 AND released_at IS NULL',
				[taskId, agentId],
			);
		});

		it('serialises a second agent on the same task: defers the wakeup back to queued and leaves only one execution lock', async () => {
			const manager = createJobManager();

			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);
			await db.query(
				"UPDATE projects SET container_id = 'test-container-id', container_status = 'running' WHERE id = $1",
				[projectId],
			);
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE task_id = $1 AND released_at IS NULL',
				[taskId],
			);

			const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
				headers: authHeader(token),
			});
			const agents = (await agentsRes.json()).data;
			const secondAgentId = agents.find((a: { id: string }) => a.id !== agentId).id;

			// Pretend agent 1 is mid-run holding the task's lock — the exact state
			// activateAgent creates before launchTask (an execution_locks row plus
			// the in-memory activeTaskRuns guard that isTaskBusy consults). Driving
			// a real background runAgent here would race these assertions: the
			// stubbed run dies immediately and its completion path releases the lock.
			await db.query(
				`INSERT INTO execution_locks (task_id, member_id, lock_type) VALUES ($1, $2, 'read')`,
				[taskId, agentId],
			);
			(manager as any).activeTaskRuns.add(taskId);

			const secondWakeup = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at, payload)
				 VALUES ($1, $2, 'mention', 'claimed', now() - interval '30 seconds', $3::jsonb)
				 RETURNING id`,
				[secondAgentId, teamId, JSON.stringify({ task_id: taskId })],
			);
			await (manager as any).activateAgent(secondAgentId, teamId, secondWakeup.rows[0].id, {
				task_id: taskId,
			});

			// Per-task serialisation: only the first agent should hold an execution lock.
			const locks = await db.query<{ member_id: string }>(
				`SELECT member_id FROM execution_locks
				 WHERE task_id = $1 AND released_at IS NULL
				 ORDER BY locked_at`,
				[taskId],
			);
			const holders = locks.rows.map((r) => r.member_id);
			expect(holders).toEqual([agentId]);

			// The second wakeup should have been re-queued for a future tick.
			const secondStatus = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[secondWakeup.rows[0].id],
			);
			expect(secondStatus.rows[0].status).toBe(WakeupStatus.Queued);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [secondWakeup.rows[0].id]);
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE task_id = $1 AND released_at IS NULL',
				[taskId],
			);
		});

		it('defers the wakeup when the same agent already holds a lock on the task', async () => {
			const manager = createJobManager();

			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);
			await db.query(
				"UPDATE projects SET container_id = 'test-container-id', container_status = 'running' WHERE id = $1",
				[projectId],
			);
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE task_id = $1 AND released_at IS NULL',
				[taskId],
			);

			await db.query(
				"INSERT INTO execution_locks (task_id, member_id, lock_type) VALUES ($1, $2, 'read')",
				[taskId, agentId],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at, payload)
				 VALUES ($1, $2, 'mention', 'claimed', now() - interval '30 seconds', $3::jsonb)
				 RETURNING id`,
				[agentId, teamId, JSON.stringify({ task_id: taskId })],
			);
			await (manager as any).activateAgent(agentId, teamId, wakeupRes.rows[0].id, {
				task_id: taskId,
			});

			const status = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupRes.rows[0].id],
			);
			expect(status.rows[0].status).toBe(WakeupStatus.Deferred);

			const locks = await db.query<{ id: string }>(
				'SELECT id FROM execution_locks WHERE task_id = $1 AND member_id = $2 AND released_at IS NULL',
				[taskId, agentId],
			);
			expect(locks.rows.length).toBe(1);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupRes.rows[0].id]);
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE task_id = $1 AND released_at IS NULL',
				[taskId],
			);
		});

		it('with task_done trigger wakeup marks completed when trigger task is not found', async () => {
			const manager = createJobManager();

			// Unassign the task so the agent has no open assigned tasks
			await db.query('UPDATE tasks SET assignee_id = NULL WHERE id = $1', [taskId]);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at, payload)
				 VALUES ($1, $2, 'automation', 'claimed', now() - interval '30 seconds',
				         '{"trigger": "task_done", "task_id": "00000000-0000-0000-0000-000000000099"}'::jsonb)
				 RETURNING id`,
				[agentId, teamId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).activateAgent(agentId, teamId, wakeupId, {
				trigger: 'task_done',
				task_id: '00000000-0000-0000-0000-000000000099',
			});

			const result = await db.query<{ status: string; completed_at: string | null }>(
				'SELECT status, completed_at FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(result.rows[0].status).toBe(WakeupStatus.Completed);
			expect(result.rows[0].completed_at).not.toBeNull();

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		});
	});

	describe('onAgentComplete', () => {
		it('releases execution lock and marks wakeup as completed on success', async () => {
			const manager = createJobManager();

			// Create a fresh execution lock
			await db.query(
				`INSERT INTO execution_locks (task_id, member_id)
				 VALUES ($1, $2)
				 ON CONFLICT DO NOTHING`,
				[taskId, agentId],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).onAgentComplete(
				agentId,
				'test-agent',
				taskId,
				taskIdentifier,
				teamId,
				wakeupId,
				undefined,
				{
					success: true,
					exitCode: 0,
					stdout: '',
					stderr: '',
				},
			);

			// Lock should be released
			const lockResult = await db.query<{ released_at: string | null }>(
				'SELECT released_at FROM execution_locks WHERE task_id = $1 AND member_id = $2 ORDER BY locked_at DESC LIMIT 1',
				[taskId, agentId],
			);
			expect(lockResult.rows[0].released_at).not.toBeNull();

			// Wakeup should be completed
			const wakeupResult = await db.query<{ status: string; completed_at: string | null }>(
				'SELECT status, completed_at FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(wakeupResult.rows[0].status).toBe(WakeupStatus.Completed);
			expect(wakeupResult.rows[0].completed_at).not.toBeNull();

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		});

		it('marks wakeup as failed when run result is failure', async () => {
			const manager = createJobManager();

			// Create a fresh execution lock
			await db.query(
				`INSERT INTO execution_locks (task_id, member_id)
				 VALUES ($1, $2)
				 ON CONFLICT DO NOTHING`,
				[taskId, agentId],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).onAgentComplete(
				agentId,
				'test-agent',
				taskId,
				taskIdentifier,
				teamId,
				wakeupId,
				undefined,
				{
					success: false,
					exitCode: 1,
					stdout: '',
					stderr: 'something went wrong',
				},
			);

			// Wakeup should be failed
			const wakeupResult = await db.query<{ status: string; completed_at: string | null }>(
				'SELECT status, completed_at FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(wakeupResult.rows[0].status).toBe(WakeupStatus.Failed);
			expect(wakeupResult.rows[0].completed_at).not.toBeNull();

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		});

		it('releases lock even when no wakeup id provided (heartbeat run)', async () => {
			const manager = createJobManager();

			// Create a fresh execution lock
			await db.query(
				`INSERT INTO execution_locks (task_id, member_id)
				 VALUES ($1, $2)
				 ON CONFLICT DO NOTHING`,
				[taskId, agentId],
			);

			// Call without a wakeupId (heartbeat-triggered run scenario)
			await (manager as any).onAgentComplete(
				agentId,
				'test-agent',
				taskId,
				taskIdentifier,
				teamId,
				undefined,
				undefined,
				{
					success: true,
					exitCode: 0,
					stdout: '',
					stderr: '',
				},
			);

			// Lock should still be released
			const lockResult = await db.query<{ released_at: string | null }>(
				'SELECT released_at FROM execution_locks WHERE task_id = $1 AND member_id = $2 ORDER BY locked_at DESC LIMIT 1',
				[taskId, agentId],
			);
			expect(lockResult.rows[0].released_at).not.toBeNull();

			manager.shutdown();
		});

		describe('failure pings', () => {
			async function seedRun(
				status: HeartbeatRunStatus,
				error: string | null = null,
				startedOffsetSeconds = 0,
			): Promise<string> {
				const r = await db.query<{ id: string }>(
					`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, error, started_at)
					 VALUES ($1, $2, $3, $4::heartbeat_run_status, $5, now() - ($6 || ' seconds')::interval)
					 RETURNING id`,
					[agentId, teamId, taskId, status, error, String(startedOffsetSeconds)],
				);
				return r.rows[0].id;
			}

			async function clearRunsAndComments(): Promise<void> {
				await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
				await db.query("DELETE FROM task_comments WHERE task_id = $1 AND content_type = 'system'", [
					taskId,
				]);
				await db.query('DELETE FROM heartbeat_runs WHERE task_id = $1 AND member_id = $2', [
					taskId,
					agentId,
				]);
			}

			async function readSystemComments(): Promise<
				Array<{ content: Record<string, unknown>; author_member_id: string | null }>
			> {
				const r = await db.query<{
					content: Record<string, unknown>;
					author_member_id: string | null;
				}>(
					`SELECT content, author_member_id FROM task_comments
					 WHERE task_id = $1 AND content_type = 'system'
					 ORDER BY created_at ASC`,
					[taskId],
				);
				return r.rows;
			}

			it('posts a system comment on failed status without queuing a retry wakeup', async () => {
				await clearRunsAndComments();
				const runId = await seedRun(HeartbeatRunStatus.Failed, 'The operation timed out.');

				const manager = createJobManager();
				await (manager as any).onAgentComplete(
					agentId,
					'researcher',
					taskId,
					taskIdentifier,
					teamId,
					undefined,
					undefined,
					{
						success: false,
						exitCode: -1,
						stdout: '',
						stderr: 'The operation timed out.',
						heartbeatRunId: runId,
					},
				);

				const comments = await readSystemComments();
				const failurePings = comments.filter((c) => c.content.kind === 'run_failed');
				expect(failurePings.length).toBe(1);
				expect(failurePings[0].author_member_id).toBeNull();
				expect(failurePings[0].content.run_id).toBe(runId);
				expect(failurePings[0].content.status).toBe(HeartbeatRunStatus.Failed);
				expect(failurePings[0].content.error).toBe('The operation timed out.');
				expect(failurePings[0].content.agent_slug).toBe('researcher');
				expect(failurePings[0].content.member_id).toBe(agentId);

				const wakeups = await db.query<{ source: string; payload: Record<string, unknown> }>(
					`SELECT source::text AS source, payload FROM agent_wakeup_requests
					 WHERE member_id = $1 AND source = 'automation' AND payload->>'reason' = 'run_failed'`,
					[agentId],
				);
				expect(wakeups.rows.length).toBe(0);

				manager.shutdown();
				await clearRunsAndComments();
			});

			it('posts the ping on timed_out status without queuing a retry wakeup', async () => {
				await clearRunsAndComments();
				const runId = await seedRun(HeartbeatRunStatus.TimedOut, 'Heartbeat lapsed');

				const manager = createJobManager();
				await (manager as any).onAgentComplete(
					agentId,
					'researcher',
					taskId,
					taskIdentifier,
					teamId,
					undefined,
					undefined,
					{
						success: false,
						exitCode: -1,
						stdout: '',
						stderr: '',
						heartbeatRunId: runId,
					},
				);

				const comments = await readSystemComments();
				const failurePings = comments.filter((c) => c.content.kind === 'run_failed');
				expect(failurePings.length).toBe(1);
				expect(failurePings[0].content.status).toBe(HeartbeatRunStatus.TimedOut);

				const wakeups = await db.query<{ id: string }>(
					`SELECT id FROM agent_wakeup_requests
					 WHERE member_id = $1 AND source = 'automation' AND payload->>'reason' = 'run_failed'`,
					[agentId],
				);
				expect(wakeups.rows.length).toBe(0);

				manager.shutdown();
				await clearRunsAndComments();
			});

			it('suppresses the ping after 3 consecutive failures', async () => {
				await clearRunsAndComments();
				await seedRun(HeartbeatRunStatus.Failed, 'first', 30);
				await seedRun(HeartbeatRunStatus.Failed, 'second', 20);
				const runId = await seedRun(HeartbeatRunStatus.Failed, 'third', 10);

				const manager = createJobManager();
				await (manager as any).onAgentComplete(
					agentId,
					'researcher',
					taskId,
					taskIdentifier,
					teamId,
					undefined,
					undefined,
					{
						success: false,
						exitCode: -1,
						stdout: '',
						stderr: 'third',
						heartbeatRunId: runId,
					},
				);

				const comments = await readSystemComments();
				const failurePings = comments.filter((c) => c.content.kind === 'run_failed');
				expect(failurePings.length).toBe(0);

				const wakeups = await db.query<{ id: string }>(
					`SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'automation'`,
					[agentId],
				);
				expect(wakeups.rows.length).toBe(0);

				manager.shutdown();
				await clearRunsAndComments();
			});

			it('resumes pinging after an intervening successful run', async () => {
				await clearRunsAndComments();
				await seedRun(HeartbeatRunStatus.Failed, 'first', 40);
				await seedRun(HeartbeatRunStatus.Failed, 'second', 30);
				await seedRun(HeartbeatRunStatus.Succeeded, null, 20);
				const runId = await seedRun(HeartbeatRunStatus.Failed, 'after recovery', 10);

				const manager = createJobManager();
				await (manager as any).onAgentComplete(
					agentId,
					'researcher',
					taskId,
					taskIdentifier,
					teamId,
					undefined,
					undefined,
					{
						success: false,
						exitCode: -1,
						stdout: '',
						stderr: 'after recovery',
						heartbeatRunId: runId,
					},
				);

				const comments = await readSystemComments();
				const failurePings = comments.filter((c) => c.content.kind === 'run_failed');
				expect(failurePings.length).toBe(1);

				manager.shutdown();
				await clearRunsAndComments();
			});

			it('does not ping on cancelled status', async () => {
				await clearRunsAndComments();
				const runId = await seedRun(HeartbeatRunStatus.Cancelled, null);

				const manager = createJobManager();
				await (manager as any).onAgentComplete(
					agentId,
					'researcher',
					taskId,
					taskIdentifier,
					teamId,
					undefined,
					undefined,
					{
						success: false,
						exitCode: -1,
						stdout: '',
						stderr: 'cancelled',
						heartbeatRunId: runId,
					},
				);

				const comments = await readSystemComments();
				expect(comments.filter((c) => c.content.kind === 'run_failed').length).toBe(0);

				const wakeups = await db.query<{ id: string }>(
					`SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'automation'`,
					[agentId],
				);
				expect(wakeups.rows.length).toBe(0);

				manager.shutdown();
				await clearRunsAndComments();
			});

			it('does not ping on successful runs', async () => {
				await clearRunsAndComments();
				const runId = await seedRun(HeartbeatRunStatus.Succeeded, null);

				const manager = createJobManager();
				await (manager as any).onAgentComplete(
					agentId,
					'researcher',
					taskId,
					taskIdentifier,
					teamId,
					undefined,
					undefined,
					{
						success: true,
						exitCode: 0,
						stdout: '',
						stderr: '',
						heartbeatRunId: runId,
					},
				);

				const comments = await readSystemComments();
				expect(comments.filter((c) => c.content.kind === 'run_failed').length).toBe(0);

				manager.shutdown();
				await clearRunsAndComments();
			});
		});

		it('chains a wakeup for the next assigned non-terminal task', async () => {
			const manager = createJobManager();

			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);
			await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
				TaskStatus.Backlog,
				taskId,
			]);

			const meta = await db.query<{ task_prefix: string; number: number }>(
				`SELECT p.task_prefix, next_project_task_number(p.id) AS number
				 FROM projects p WHERE p.id = $1`,
				[projectId],
			);
			const nextNumber = meta.rows[0].number;
			const nextInsert = await db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, description, status, priority, labels)
				 VALUES ($1, $2, $3, $4, $5, $6, '', $7::task_status, 'medium'::task_priority, '[]'::jsonb)
				 RETURNING id`,
				[
					teamId,
					projectId,
					agentId,
					nextNumber,
					`${meta.rows[0].task_prefix}-${nextNumber}`,
					'Next queued ticket',
					TaskStatus.Backlog,
				],
			);
			const nextTaskId = nextInsert.rows[0].id;

			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

			await (manager as any).onAgentComplete(
				agentId,
				'test-agent',
				taskId,
				taskIdentifier,
				teamId,
				undefined,
				undefined,
				{
					success: true,
					exitCode: 0,
					stdout: '',
					stderr: '',
				},
			);

			const chain = await db.query<{ source: string; payload: Record<string, unknown> }>(
				`SELECT source, payload FROM agent_wakeup_requests
				 WHERE member_id = $1 AND status = $2::wakeup_status
				 ORDER BY created_at DESC LIMIT 1`,
				[agentId, WakeupStatus.Queued],
			);
			expect(chain.rows.length).toBe(1);
			expect(chain.rows[0].source).toBe('timer');
			expect(chain.rows[0].payload.task_id).toBe(nextTaskId);
			expect(chain.rows[0].payload.reason).toBe('chain_after_completion');

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
			await db.query('DELETE FROM tasks WHERE id = $1', [nextTaskId]);
		});

		it('does not chain a wakeup when no other assigned tasks exist', async () => {
			const manager = createJobManager();

			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
			await db.query(
				`UPDATE tasks SET assignee_id = NULL
				 WHERE assignee_id = $1 AND id != $2
				   AND status NOT IN ('done', 'cancelled')`,
				[agentId, taskId],
			);
			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);

			await (manager as any).onAgentComplete(
				agentId,
				'test-agent',
				taskId,
				taskIdentifier,
				teamId,
				undefined,
				undefined,
				{
					success: true,
					exitCode: 0,
					stdout: '',
					stderr: '',
				},
			);

			const chain = await db.query<{ id: string }>(
				`SELECT id FROM agent_wakeup_requests
				 WHERE member_id = $1 AND status = $2::wakeup_status
				   AND source = 'timer'`,
				[agentId, WakeupStatus.Queued],
			);
			expect(chain.rows.length).toBe(0);

			manager.shutdown();
		});

		it('does not chain to a task the agent is concurrently running on', async () => {
			const manager = createJobManager();

			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);
			await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
				TaskStatus.Backlog,
				taskId,
			]);

			const meta = await db.query<{ task_prefix: string; number: number }>(
				`SELECT p.task_prefix, next_project_task_number(p.id) AS number
				 FROM projects p WHERE p.id = $1`,
				[projectId],
			);
			const siblingInsert = await db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, description, status, priority, labels)
				 VALUES ($1, $2, $3, $4, $5, $6, '', $7::task_status, 'medium'::task_priority, '[]'::jsonb)
				 RETURNING id`,
				[
					teamId,
					projectId,
					agentId,
					meta.rows[0].number,
					`${meta.rows[0].task_prefix}-${meta.rows[0].number}`,
					'Sibling ticket already in flight',
					TaskStatus.InProgress,
				],
			);
			const siblingTaskId = siblingInsert.rows[0].id;

			// Active concurrent run on the sibling — this is the case where the
			// pre-fix chain logic would queue a redundant wakeup targeting it.
			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
				[agentId, teamId, siblingTaskId, HeartbeatRunStatus.Running],
			);
			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

			await (manager as any).onAgentComplete(
				agentId,
				'test-agent',
				taskId,
				taskIdentifier,
				teamId,
				undefined,
				undefined,
				{ success: true, exitCode: 0, stdout: '', stderr: '' },
			);

			const chain = await db.query<{ id: string }>(
				`SELECT id FROM agent_wakeup_requests
				 WHERE member_id = $1 AND source = 'timer'`,
				[agentId],
			);
			expect(chain.rows.length).toBe(0);

			manager.shutdown();
			await db.query('DELETE FROM heartbeat_runs WHERE task_id = $1', [siblingTaskId]);
			await db.query('DELETE FROM tasks WHERE id = $1', [siblingTaskId]);
		});

		it('does not chain to a task that already has a queued wakeup for the agent', async () => {
			const manager = createJobManager();

			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);
			await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
				TaskStatus.Backlog,
				taskId,
			]);

			const meta = await db.query<{ task_prefix: string; number: number }>(
				`SELECT p.task_prefix, next_project_task_number(p.id) AS number
				 FROM projects p WHERE p.id = $1`,
				[projectId],
			);
			const siblingInsert = await db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, description, status, priority, labels)
				 VALUES ($1, $2, $3, $4, $5, $6, '', $7::task_status, 'medium'::task_priority, '[]'::jsonb)
				 RETURNING id`,
				[
					teamId,
					projectId,
					agentId,
					meta.rows[0].number,
					`${meta.rows[0].task_prefix}-${meta.rows[0].number}`,
					'Sibling ticket with pending wakeup',
					TaskStatus.Backlog,
				],
			);
			const siblingTaskId = siblingInsert.rows[0].id;

			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
			// Pre-existing queued wakeup for the sibling — the assignee assignment
			// just enqueued one and it hasn't been picked up yet.
			await db.query(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
				 VALUES ($1, $2, 'assignment'::wakeup_source, 'queued'::wakeup_status, $3::jsonb)`,
				[agentId, teamId, JSON.stringify({ task_id: siblingTaskId })],
			);

			await (manager as any).onAgentComplete(
				agentId,
				'test-agent',
				taskId,
				taskIdentifier,
				teamId,
				undefined,
				undefined,
				{ success: true, exitCode: 0, stdout: '', stderr: '' },
			);

			const chain = await db.query<{ id: string }>(
				`SELECT id FROM agent_wakeup_requests
				 WHERE member_id = $1 AND source = 'timer'`,
				[agentId],
			);
			expect(chain.rows.length).toBe(0);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
			await db.query('DELETE FROM tasks WHERE id = $1', [siblingTaskId]);
		});

		it('does not chain back to a task the agent succeeded on within its heartbeat interval', async () => {
			const manager = createJobManager();

			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);
			await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
				TaskStatus.Backlog,
				taskId,
			]);

			const meta = await db.query<{ task_prefix: string; number: number }>(
				`SELECT p.task_prefix, next_project_task_number(p.id) AS number
				 FROM projects p WHERE p.id = $1`,
				[projectId],
			);
			const siblingInsert = await db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, description, status, priority, labels)
				 VALUES ($1, $2, $3, $4, $5, $6, '', $7::task_status, 'medium'::task_priority, '[]'::jsonb)
				 RETURNING id`,
				[
					teamId,
					projectId,
					agentId,
					meta.rows[0].number,
					`${meta.rows[0].task_prefix}-${meta.rows[0].number}`,
					'Sibling already worked recently',
					TaskStatus.Backlog,
				],
			);
			const siblingTaskId = siblingInsert.rows[0].id;

			// Use a generous heartbeat interval so the "recent success" window
			// is unambiguous in test time.
			await db.query('UPDATE member_agents SET heartbeat_interval_min = 60 WHERE id = $1', [
				agentId,
			]);

			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
			await db.query('DELETE FROM heartbeat_runs WHERE member_id = $1', [agentId]);

			// A succeeded run by this agent on the sibling that finished a minute
			// ago — well inside the 60-min heartbeat interval, so the sibling is
			// not yet due to be re-picked.
			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '90 seconds', now() - interval '60 seconds')`,
				[agentId, teamId, siblingTaskId, HeartbeatRunStatus.Succeeded],
			);

			await (manager as any).onAgentComplete(
				agentId,
				'test-agent',
				taskId,
				taskIdentifier,
				teamId,
				undefined,
				undefined,
				{ success: true, exitCode: 0, stdout: '', stderr: '' },
			);

			const chain = await db.query<{ id: string }>(
				`SELECT id FROM agent_wakeup_requests
				 WHERE member_id = $1 AND source = 'timer'`,
				[agentId],
			);
			expect(chain.rows.length).toBe(0);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
			await db.query('DELETE FROM heartbeat_runs WHERE member_id = $1', [agentId]);
			await db.query('DELETE FROM tasks WHERE id = $1', [siblingTaskId]);
		});

		it('does chain to a task whose last succeeded run is older than the heartbeat interval', async () => {
			const manager = createJobManager();

			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);
			await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
				TaskStatus.Backlog,
				taskId,
			]);

			const meta = await db.query<{ task_prefix: string; number: number }>(
				`SELECT p.task_prefix, next_project_task_number(p.id) AS number
				 FROM projects p WHERE p.id = $1`,
				[projectId],
			);
			const siblingInsert = await db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, description, status, priority, labels)
				 VALUES ($1, $2, $3, $4, $5, $6, '', $7::task_status, 'medium'::task_priority, '[]'::jsonb)
				 RETURNING id`,
				[
					teamId,
					projectId,
					agentId,
					meta.rows[0].number,
					`${meta.rows[0].task_prefix}-${meta.rows[0].number}`,
					'Sibling last worked long ago',
					TaskStatus.Backlog,
				],
			);
			const siblingTaskId = siblingInsert.rows[0].id;

			// Heartbeat interval of 5 min (matches the floor). A run that finished
			// a year ago is unambiguously outside the cooldown regardless of CI
			// clock precision or test ordering.
			await db.query('UPDATE member_agents SET heartbeat_interval_min = 5 WHERE id = $1', [
				agentId,
			]);

			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
			await db.query('DELETE FROM heartbeat_runs WHERE member_id = $1', [agentId]);

			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '1 year' - interval '1 hour', now() - interval '1 year')`,
				[agentId, teamId, siblingTaskId, HeartbeatRunStatus.Succeeded],
			);

			await (manager as any).onAgentComplete(
				agentId,
				'test-agent',
				taskId,
				taskIdentifier,
				teamId,
				undefined,
				undefined,
				{ success: true, exitCode: 0, stdout: '', stderr: '' },
			);

			// Specifically query for the chain wakeup targeting the sibling, so
			// the assertion is unaffected by any other wakeup that might exist for
			// the agent (e.g. from prior tests or side effects of onAgentComplete).
			const chain = await db.query<{ payload: Record<string, unknown> }>(
				`SELECT payload FROM agent_wakeup_requests
				 WHERE member_id = $1
				   AND source = 'timer'::wakeup_source
				   AND payload->>'task_id' = $2
				   AND payload->>'reason' = 'chain_after_completion'`,
				[agentId, siblingTaskId],
			);
			expect(chain.rows.length).toBe(1);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
			await db.query('DELETE FROM heartbeat_runs WHERE member_id = $1', [agentId]);
			await db.query('DELETE FROM tasks WHERE id = $1', [siblingTaskId]);
		});
	});

	describe('coach review on a done task', () => {
		async function setTaskDone(): Promise<void> {
			await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
				TaskStatus.Done,
				taskId,
			]);
		}

		async function readTaskStatus(): Promise<string> {
			const r = await db.query<{ status: string }>(
				'SELECT status::text AS status FROM tasks WHERE id = $1',
				[taskId],
			);
			return r.rows[0].status;
		}

		// `done` is the final completed state; the Coach reviews it for
		// prompt-learning but no longer changes the task's status.
		it('leaves a Done task in Done after a successful coach run (no auto-close)', async () => {
			const manager = createJobManager();
			await setTaskDone();

			await (manager as any).onAgentComplete(
				agentId,
				'coach',
				taskId,
				taskIdentifier,
				teamId,
				undefined,
				{ trigger: 'task_done', task_id: taskId },
				{ success: true, exitCode: 0, stdout: '', stderr: '' },
			);

			expect(await readTaskStatus()).toBe(TaskStatus.Done);
			manager.shutdown();
		});
	});

	describe('processScheduledHeartbeats', () => {
		it('finds agents with past-due heartbeats via query', async () => {
			// Ensure the agent is enabled and idle with an overdue heartbeat
			await db.query(
				"UPDATE member_agents SET admin_status = 'enabled', runtime_status = 'idle', last_heartbeat_at = now() - interval '2 hours', heartbeat_interval_min = 60 WHERE id = $1",
				[agentId],
			);

			// The processScheduledHeartbeats query should find this agent
			const dueAgents = await db.query<{ id: string; team_id: string }>(
				`SELECT ma.id, m.team_id, ma.heartbeat_interval_min
				 FROM member_agents ma
				 JOIN members m ON m.id = ma.id
				 WHERE ma.admin_status = 'enabled'
				   AND ma.runtime_status <> ALL('{out_of_agent_budget,out_of_project_budget}'::agent_runtime_status[])
				   AND (ma.last_heartbeat_at IS NULL
				        OR ma.last_heartbeat_at + (ma.heartbeat_interval_min || ' minutes')::interval < now())
				 LIMIT 20`,
				[],
			);

			const ids = dueAgents.rows.map((a) => a.id);
			expect(ids).toContain(agentId);
		});

		it('creates a Heartbeat wakeup row before activating a due agent', async () => {
			const manager = createJobManager();

			// Sanity-check: clear any prior state and make this agent eligible.
			// Other seeded agents start with last_heartbeat_at = NULL and would
			// also satisfy processScheduledHeartbeats's WHERE clause; with
			// `LIMIT 5` on the query, this test's specific agent could be
			// crowded out non-deterministically. Mark every other agent as
			// recently heartbeated so this test's agent is the only due one.
			await db.query(
				"UPDATE member_agents SET admin_status = 'enabled', runtime_status = 'idle', last_heartbeat_at = now() - interval '2 hours', heartbeat_interval_min = 60 WHERE id = $1",
				[agentId],
			);
			await db.query(
				'UPDATE member_agents SET last_heartbeat_at = now(), heartbeat_interval_min = 60 WHERE id != $1',
				[agentId],
			);
			await db.query('DELETE FROM agent_wakeup_requests');
			// Prior tests' background runAgent may have written a recent
			// heartbeat_runs row, which puts this agent into the post-run
			// cooldown window and excludes it from processScheduledHeartbeats.
			await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);

			const dueCheck = await db.query<{ id: string }>(
				`SELECT ma.id
				 FROM member_agents ma
				 JOIN members m ON m.id = ma.id
				 WHERE ma.admin_status = 'enabled'
				   AND ma.runtime_status <> ALL('{out_of_agent_budget,out_of_project_budget}'::agent_runtime_status[])
				   AND (ma.last_heartbeat_at IS NULL
				        OR ma.last_heartbeat_at + (ma.heartbeat_interval_min || ' minutes')::interval < now())
				   AND ma.id = $1`,
				[agentId],
			);
			expect(dueCheck.rows.length).toBe(1);

			await (manager as any).processScheduledHeartbeats();

			const wakeups = await db.query<{ source: string; payload: Record<string, unknown> }>(
				`SELECT source::text AS source, payload FROM agent_wakeup_requests
				 WHERE member_id = $1 AND source = 'heartbeat'`,
				[agentId],
			);
			expect(wakeups.rows.length).toBeGreaterThan(0);
			expect(wakeups.rows[0].payload).toMatchObject({ reason: 'scheduled_heartbeat' });

			manager.shutdown();
		});

		it('skips agents with null last_heartbeat_at that already have running tasks', async () => {
			const manager = createJobManager();

			// Simulate a running task already (project-scoped key matches activateAgent).
			// Body listens to the abort signal so `manager.shutdown()` actually unwinds
			// the launched promise instead of leaving a setTimeout running into the
			// next test's window.
			manager.launchTask(
				`${agentId}:${projectId}`,
				(signal) =>
					new Promise<void>((resolve) => {
						if (signal.aborted) return resolve();
						const timer = setTimeout(resolve, 5000);
						signal.addEventListener(
							'abort',
							() => {
								clearTimeout(timer);
								resolve();
							},
							{ once: true },
						);
					}),
				10_000,
			);

			// Agent has never heartbeated, so it should normally be picked up
			await db.query('UPDATE member_agents SET last_heartbeat_at = NULL WHERE id = $1', [agentId]);

			// Count launches before
			const taskWasRunning = manager.isMemberRunning(agentId);
			expect(taskWasRunning).toBe(true);

			await (manager as any).processScheduledHeartbeats();

			// Task still running (was not restarted — the existing task was skipped)
			expect(manager.isMemberRunning(agentId)).toBe(true);

			manager.shutdown();
		});

		it('honours the interval floor when heartbeat_interval_min is misconfigured low', async () => {
			const manager = createJobManager();

			await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
			await db.query('DELETE FROM agent_wakeup_requests');
			await db.query(
				"UPDATE member_agents SET admin_status = 'enabled', runtime_status = 'idle', last_heartbeat_at = now() - interval '1 minute', heartbeat_interval_min = 0 WHERE id = $1",
				[agentId],
			);
			// Park every other seeded agent so they don't compete for the LIMIT.
			await db.query(
				'UPDATE member_agents SET last_heartbeat_at = now(), heartbeat_interval_min = 60 WHERE id != $1',
				[agentId],
			);

			await (manager as any).processScheduledHeartbeats();

			const wakeups = await db.query<{ id: string }>(
				`SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'heartbeat'`,
				[agentId],
			);
			expect(wakeups.rows.length).toBe(0);

			manager.shutdown();
		});

		it('defers heartbeats while another run for the same agent ended within the cooldown window', async () => {
			const manager = createJobManager();

			await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
			await db.query('DELETE FROM agent_wakeup_requests');
			await db.query(
				"UPDATE member_agents SET admin_status = 'enabled', runtime_status = 'idle', last_heartbeat_at = now() - interval '2 hours', heartbeat_interval_min = 60 WHERE id = $1",
				[agentId],
			);
			await db.query(
				'UPDATE member_agents SET last_heartbeat_at = now(), heartbeat_interval_min = 60 WHERE id != $1',
				[agentId],
			);
			await db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, status, started_at, finished_at)
				 VALUES ($1, $2, $3::heartbeat_run_status, now() - interval '5 seconds', now() - interval '2 seconds')`,
				[teamId, agentId, HeartbeatRunStatus.Succeeded],
			);

			await (manager as any).processScheduledHeartbeats();

			const wakeups = await db.query<{ id: string }>(
				`SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'heartbeat'`,
				[agentId],
			);
			expect(wakeups.rows.length).toBe(0);

			manager.shutdown();
		});

		it('does not process agents in a budget-pause state', async () => {
			const manager = createJobManager();

			await db.query(
				'UPDATE member_agents SET last_heartbeat_at = now(), heartbeat_interval_min = 60 WHERE id != $1',
				[agentId],
			);
			await db.query('DELETE FROM agent_wakeup_requests');
			await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
			// Over budget (out_of_agent_budget) and otherwise due — the budget pause
			// must keep it out of the scheduler just like a manual `paused`.
			await db.query(
				"UPDATE member_agents SET runtime_status = 'out_of_agent_budget', last_heartbeat_at = now() - interval '2 hours', heartbeat_interval_min = 60 WHERE id = $1",
				[agentId],
			);

			await (manager as any).processScheduledHeartbeats();

			expect(manager.isMemberRunning(agentId)).toBe(false);
			const wakeups = await db.query<{ id: string }>(
				`SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'heartbeat'`,
				[agentId],
			);
			expect(wakeups.rows.length).toBe(0);

			await db.query("UPDATE member_agents SET runtime_status = 'idle' WHERE id = $1", [agentId]);
			manager.shutdown();
		});
	});

	describe('processBudgetResumes', () => {
		it('lifts a budget pause back to idle once spend is within budget', async () => {
			const manager = createJobManager();
			await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
			// Paused for budget, but no spend and no limits → reconcile resumes it.
			await db.query(
				`UPDATE member_agents
				 SET runtime_status = 'out_of_agent_budget',
				     daily_budget_cents = 0, weekly_budget_cents = 0, monthly_budget_cents = 0
				 WHERE id = $1`,
				[agentId],
			);

			await (manager as any).processBudgetResumes();

			const status = await db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[agentId],
			);
			expect(status.rows[0].runtime_status).toBe('idle');
			manager.shutdown();
		});

		it('keeps an agent paused while still over budget', async () => {
			const manager = createJobManager();
			await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
			await db.query(
				`UPDATE member_agents SET runtime_status = 'out_of_agent_budget', daily_budget_cents = 100 WHERE id = $1`,
				[agentId],
			);
			await db.query(
				`INSERT INTO cost_entries (member_id, project_id, amount_cents) VALUES ($1, $2, 250)`,
				[agentId, projectId],
			);

			await (manager as any).processBudgetResumes();

			const status = await db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[agentId],
			);
			expect(status.rows[0].runtime_status).toBe('out_of_agent_budget');

			await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
			await db.query(
				"UPDATE member_agents SET runtime_status = 'idle', daily_budget_cents = 0 WHERE id = $1",
				[agentId],
			);
			manager.shutdown();
		});
	});

	describe('reconcileOnStartup', () => {
		it('fails stranded running heartbeat_runs and resets agent to idle', async () => {
			await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

			await db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
				[teamId, agentId, taskId, HeartbeatRunStatus.Running],
			);
			await db.query(
				'UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2',
				[AgentRuntimeStatus.Active, agentId],
			);

			const broadcasts: Array<{ table: string }> = [];
			const manager = createJobManager({
				wsManager: {
					broadcast: (_room: string, msg: { table: string }) => {
						broadcasts.push({ table: msg.table });
					},
				} as any,
			});

			await manager.reconcileOnStartup();

			const run = await db.query<{ status: string; error: string }>(
				`SELECT status, error FROM heartbeat_runs WHERE team_id = $1 ORDER BY started_at DESC LIMIT 1`,
				[teamId],
			);
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
			expect(run.rows[0].error).toContain('Server restarted');

			const agent = await db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[agentId],
			);
			expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);

			const wakeups = await db.query<{ payload: Record<string, unknown> }>(
				`SELECT payload FROM agent_wakeup_requests
				 WHERE member_id = $1 AND status = $2::wakeup_status
				 ORDER BY created_at DESC LIMIT 1`,
				[agentId, WakeupStatus.Queued],
			);
			expect((wakeups.rows[0]?.payload as Record<string, unknown>)?.reason).toBe(
				'startup_recovery',
			);

			expect(broadcasts.some((b) => b.table === 'heartbeat_runs')).toBe(true);
			expect(broadcasts.some((b) => b.table === 'member_agents')).toBe(true);

			manager.shutdown();
		});

		it('preserves a stranded run’s partial usage and charges its cost to the budget', async () => {
			await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
			await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);

			// A run the server killed mid-flight: its periodic flush left a non-zero
			// usage snapshot flagged partial, but it never completed.
			const inserted = await db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs
				   (team_id, member_id, task_id, status, started_at,
				    input_tokens, output_tokens, cost_cents, usage_partial)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now(), 1000, 200, 37, true)
				 RETURNING id`,
				[teamId, agentId, taskId, HeartbeatRunStatus.Running],
			);
			const runId = inserted.rows[0].id;

			const manager = createJobManager();
			await manager.reconcileOnStartup();

			const run = await db.query<{
				status: string;
				error: string;
				input_tokens: number;
				output_tokens: number;
				usage_partial: boolean;
			}>(
				`SELECT status, error, input_tokens, output_tokens, usage_partial
				 FROM heartbeat_runs WHERE id = $1`,
				[runId],
			);
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
			expect(run.rows[0].error).toContain('Server restarted');
			// The token snapshot survives the restart, still flagged partial.
			expect(Number(run.rows[0].input_tokens)).toBe(1000);
			expect(Number(run.rows[0].output_tokens)).toBe(200);
			expect(run.rows[0].usage_partial).toBe(true);

			// …and the surviving cost reached cost_entries (so budgets count it).
			const cost = await db.query<{ amount_cents: number }>(
				`SELECT amount_cents FROM cost_entries WHERE member_id = $1 AND description = $2`,
				[agentId, `Agent run ${runId}`],
			);
			expect(cost.rows.length).toBe(1);
			expect(Number(cost.rows[0].amount_cents)).toBe(37);

			manager.shutdown();
		});

		it('releases all open execution_locks on startup', async () => {
			await db.query('UPDATE execution_locks SET released_at = now() WHERE released_at IS NULL');
			await db.query(`INSERT INTO execution_locks (task_id, member_id) VALUES ($1, $2)`, [
				taskId,
				agentId,
			]);

			const manager = createJobManager();
			await manager.reconcileOnStartup();

			const locks = await db.query<{ released_at: string | null }>(
				`SELECT released_at FROM execution_locks WHERE released_at IS NULL`,
			);
			expect(locks.rows.length).toBe(0);

			manager.shutdown();
		});

		it('fails repos stranded pending by a restart and broadcasts the update', async () => {
			// A repo whose background setup (clone + designation) was in flight when
			// the previous process died: the work is lost, so the row must park
			// `failed` (retriable via POST) rather than stay `pending` forever.
			const inserted = await db.query<{ id: string }>(
				`INSERT INTO repos (project_id, repo_identifier, host_type, setup_status)
				 VALUES ($1, 'acme/stranded-setup', 'github', 'pending'::repo_setup_status)
				 RETURNING id`,
				[projectId],
			);

			const broadcasts: Array<{ table: string; row: Record<string, unknown> }> = [];
			const manager = createJobManager({
				wsManager: {
					broadcast: (_room: string, msg: { table: string; row: Record<string, unknown> }) => {
						broadcasts.push({ table: msg.table, row: msg.row });
					},
				} as any,
			});

			await manager.reconcileOnStartup();

			const row = await db.query<{ setup_status: string; setup_error: string | null }>(
				`SELECT setup_status::text AS setup_status, setup_error FROM repos WHERE id = $1`,
				[inserted.rows[0].id],
			);
			expect(row.rows[0].setup_status).toBe('failed');
			expect(row.rows[0].setup_error).toContain('Server restarted');

			const repoBroadcast = broadcasts.find(
				(b) => b.table === 'repos' && b.row.id === inserted.rows[0].id,
			);
			expect(repoBroadcast).toBeTruthy();
			expect(repoBroadcast?.row.setup_status).toBe('failed');

			manager.shutdown();
			await db.query('DELETE FROM repos WHERE id = $1', [inserted.rows[0].id]);
		});

		describe('container restart', () => {
			// Other projects (notably HQ) get provisioned in the background during
			// file-level setup and end up with container_status='running'. Clear all
			// projects before each test so the restart pass only sees the row the
			// test under test seeded.
			beforeEach(async () => {
				await db.query(
					`UPDATE projects
					 SET container_status = NULL, container_id = NULL, container_error = NULL`,
				);
			});

			afterEach(async () => {
				await db.query(
					`UPDATE projects
					 SET container_status = NULL, container_id = NULL, container_error = NULL`,
				);
			});

			// Default stub overrides that satisfy the post-restart repairStaleContainerMounts
			// pass — verifyContainerWorkspace runs an exec; without a non-throwing exec
			// stub it would trigger a rebuild and pollute every assertion.
			const happyExec = {
				execCreate: async () => 'exec-1',
				execStart: async () => ({ stdout: 'ok', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			};

			async function seedRunningContainer(containerId: string): Promise<void> {
				await db.query(
					`UPDATE projects
					 SET container_status = 'running'::container_status, container_id = $2, container_error = 'old error'
					 WHERE id = $1`,
					[projectId, containerId],
				);
			}

			it('starts an exited container whose DB status is running', async () => {
				await seedRunningContainer('abc');

				const startCalls: string[] = [];
				const manager = createJobManager({
					docker: createStubDocker({
						...happyExec,
						inspectContainer: async (id: string) => ({
							Id: id,
							State: { Status: 'exited', Running: false, Pid: 0, ExitCode: 0 },
							Config: { Image: 'stub' },
						}),
						startContainer: async (id: string) => {
							startCalls.push(id);
						},
					}),
				});

				await manager.reconcileOnStartup();

				expect(startCalls).toEqual(['abc']);
				const row = await db.query<{ container_error: string | null }>(
					'SELECT container_error FROM projects WHERE id = $1',
					[projectId],
				);
				expect(row.rows[0].container_error).toBe(null);

				manager.shutdown();
			});

			it('leaves an already-running container alone', async () => {
				await seedRunningContainer('abc');

				const startCalls: string[] = [];
				const manager = createJobManager({
					docker: createStubDocker({
						...happyExec,
						inspectContainer: async (id: string) => ({
							Id: id,
							State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
							Config: { Image: 'stub' },
						}),
						startContainer: async (id: string) => {
							startCalls.push(id);
						},
					}),
				});

				await manager.reconcileOnStartup();

				expect(startCalls).toEqual([]);

				manager.shutdown();
			});

			it('does not touch a project the user has explicitly stopped', async () => {
				await db.query(
					`UPDATE projects
					 SET container_status = 'stopped'::container_status, container_id = 'abc'
					 WHERE id = $1`,
					[projectId],
				);

				const startCalls: string[] = [];
				const inspectCalls: string[] = [];
				const manager = createJobManager({
					docker: createStubDocker({
						...happyExec,
						inspectContainer: async (id: string) => {
							inspectCalls.push(id);
							return {
								Id: id,
								State: { Status: 'exited', Running: false, Pid: 0, ExitCode: 0 },
								Config: { Image: 'stub' },
							};
						},
						startContainer: async (id: string) => {
							startCalls.push(id);
						},
					}),
				});

				await manager.reconcileOnStartup();

				expect(inspectCalls).not.toContain('abc');
				expect(startCalls).toEqual([]);

				manager.shutdown();
			});

			it('re-provisions a project whose container has vanished from Docker', async () => {
				await seedRunningContainer('gone');

				const createCalls: string[] = [];
				const manager = createJobManager({
					docker: createStubDocker({
						...happyExec,
						inspectContainer: async () => null,
						createContainer: async (name: string) => {
							createCalls.push(name);
							return { Id: 'fresh-container', Warnings: [] };
						},
					}),
				});

				await manager.reconcileOnStartup();

				expect(
					createCalls.some((name) =>
						name.startsWith(`hezo-${projectSlug}-${projectId.slice(0, 8)}-`),
					),
				).toBe(true);
				const row = await db.query<{ container_id: string | null; container_status: string }>(
					'SELECT container_id, container_status FROM projects WHERE id = $1',
					[projectId],
				);
				expect(row.rows[0].container_id).toBe('fresh-container');
				expect(row.rows[0].container_status).toBe('running');

				manager.shutdown();
			});

			it('skips the restart pass when Docker is unreachable', async () => {
				await seedRunningContainer('abc');

				const inspectCalls: string[] = [];
				const startCalls: string[] = [];
				const manager = createJobManager({
					docker: createStubDocker({
						...happyExec,
						ping: async () => false,
						inspectContainer: async (id: string) => {
							inspectCalls.push(id);
							return null;
						},
						startContainer: async (id: string) => {
							startCalls.push(id);
						},
					}),
				});

				await manager.reconcileOnStartup();

				expect(inspectCalls).toEqual([]);
				expect(startCalls).toEqual([]);
				const row = await db.query<{ container_id: string | null; container_status: string }>(
					'SELECT container_id, container_status FROM projects WHERE id = $1',
					[projectId],
				);
				expect(row.rows[0].container_id).toBe('abc');
				expect(row.rows[0].container_status).toBe('running');

				manager.shutdown();
			});
		});
	});

	describe('ensureHqContainerRunning', () => {
		async function hqProject(): Promise<{ id: string }> {
			const r = await db.query<{ id: string }>(
				`SELECT id FROM projects WHERE is_internal = true LIMIT 1`,
			);
			return r.rows[0];
		}

		afterEach(async () => {
			await db.query(
				`UPDATE projects SET container_status = NULL, container_id = NULL, container_error = NULL
				 WHERE is_internal = true`,
			);
		});

		it('leaves an idle-stopped HQ container alone — lazy start covers later use', async () => {
			// The warm-up is first-boot-only: once a container exists (running or
			// stopped), eagerly starting it would just wake a container the
			// idle-stop cron reclaims minutes later.
			const hq = await hqProject();
			await db.query(
				`UPDATE projects SET container_status = 'stopped'::container_status, container_id = 'hq-box'
				 WHERE id = $1`,
				[hq.id],
			);

			const startCalls: string[] = [];
			const manager = createJobManager({
				docker: createStubDocker({
					inspectContainer: async (id: string) => ({
						Id: id,
						State: { Status: 'exited', Running: false, Pid: 0, ExitCode: 0 },
						Config: { Image: 'stub' },
					}),
					startContainer: async (id: string) => {
						startCalls.push(id);
					},
				}),
			});

			await manager.ensureHqContainerRunning();

			expect(startCalls).toEqual([]);
			const row = await db.query<{ container_status: string }>(
				'SELECT container_status FROM projects WHERE id = $1',
				[hq.id],
			);
			expect(row.rows[0].container_status).toBe('stopped');

			manager.shutdown();
		});

		it('leaves an already-running HQ container alone', async () => {
			const hq = await hqProject();
			await db.query(
				`UPDATE projects SET container_status = 'running'::container_status, container_id = 'hq-box'
				 WHERE id = $1`,
				[hq.id],
			);

			const startCalls: string[] = [];
			const manager = createJobManager({
				docker: createStubDocker({
					inspectContainer: async (id: string) => ({
						Id: id,
						State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
						Config: { Image: 'stub' },
					}),
					startContainer: async (id: string) => {
						startCalls.push(id);
					},
				}),
			});

			await manager.ensureHqContainerRunning();

			expect(startCalls).toEqual([]);

			manager.shutdown();
		});

		it('skips the warm-up when Docker is unreachable', async () => {
			const hq = await hqProject();
			await db.query(
				`UPDATE projects SET container_status = 'stopped'::container_status, container_id = 'hq-box'
				 WHERE id = $1`,
				[hq.id],
			);

			const startCalls: string[] = [];
			const manager = createJobManager({
				docker: createStubDocker({
					ping: async () => false,
					startContainer: async (id: string) => {
						startCalls.push(id);
					},
				}),
			});

			await manager.ensureHqContainerRunning();

			expect(startCalls).toEqual([]);

			manager.shutdown();
		});
	});

	describe('live-run registry', () => {
		it('register / unregister updates getLiveRunIds and getLiveRunsForProject', () => {
			const manager = createJobManager();
			manager.registerLiveRun({
				runId: 'run-1',
				memberId: 'm-1',
				taskId: 'i-1',
				projectId: 'p-1',
				teamId: 'c-1',
				taskKey: 'agent:m-1',
			});
			manager.registerLiveRun({
				runId: 'run-2',
				memberId: 'm-2',
				taskId: 'i-2',
				projectId: 'p-1',
				teamId: 'c-1',
				taskKey: 'agent:m-2',
			});
			manager.registerLiveRun({
				runId: 'run-3',
				memberId: 'm-3',
				taskId: 'i-3',
				projectId: 'p-2',
				teamId: 'c-1',
				taskKey: 'agent:m-3',
			});

			expect(manager.getLiveRunIds()).toEqual(new Set(['run-1', 'run-2', 'run-3']));
			expect(
				manager
					.getLiveRunsForProject('p-1')
					.map((r) => r.runId)
					.sort(),
			).toEqual(['run-1', 'run-2']);

			manager.unregisterLiveRun('run-2');
			expect(manager.getLiveRunIds()).toEqual(new Set(['run-1', 'run-3']));

			manager.shutdown();
		});
	});

	describe('per-task serialisation', () => {
		it('leaves a wakeup queued when another agent has an active run on the same task', async () => {
			const manager = createJobManager();

			// Simulate an active run on the task (from a different agent).
			const otherAgentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Other Agent For Serialisation' }),
			});
			const otherAgentId = (await otherAgentRes.json()).data.id;

			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
				[otherAgentId, teamId, taskId, HeartbeatRunStatus.Running],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at, payload)
				 VALUES ($1, $2, 'mention', 'queued', now() - interval '30 seconds', $3::jsonb)
				 RETURNING id`,
				[agentId, teamId, JSON.stringify({ task_id: taskId })],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).processWakeups();

			const result = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(result.rows[0].status).toBe(WakeupStatus.Queued);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
			await db.query('DELETE FROM heartbeat_runs WHERE task_id = $1 AND member_id = $2', [
				taskId,
				otherAgentId,
			]);
		});

		it('isTaskBusy is false when payload has no task_id', async () => {
			const manager = createJobManager();
			const busy = await (manager as any).isTaskBusy({});
			expect(busy).toBe(false);
			manager.shutdown();
		});

		it('isTaskBusy returns true while an active run exists', async () => {
			const manager = createJobManager();
			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
				[agentId, teamId, taskId, HeartbeatRunStatus.Running],
			);

			const busy = await (manager as any).isTaskBusy({ task_id: taskId });
			expect(busy).toBe(true);

			await db.query(
				"UPDATE heartbeat_runs SET status = 'succeeded', finished_at = now() WHERE task_id = $1 AND member_id = $2",
				[taskId, agentId],
			);
			const busyAfter = await (manager as any).isTaskBusy({ task_id: taskId });
			expect(busyAfter).toBe(false);

			manager.shutdown();
			await db.query('DELETE FROM heartbeat_runs WHERE task_id = $1 AND member_id = $2', [
				taskId,
				agentId,
			]);
		});
	});

	describe('container-capacity gating and cross-project parallelism', () => {
		it('isContainerCapacityBlocked trips when a new container would exceed the limit', async () => {
			const manager = createJobManager();
			await setContainerCapacityForTest(db, 1);
			await stopProjectContainers(db, projectId);
			await seedRunningContainerProject(db, 'cap-check-a');

			expect(await (manager as any).isContainerCapacityBlocked(projectId)).toBe(true);

			// The filler's container stops — the slot frees and the block lifts.
			await db.query(`UPDATE projects SET container_status = 'stopped' WHERE slug = 'cap-check-a'`);
			expect(await (manager as any).isContainerCapacityBlocked(projectId)).toBe(false);

			manager.shutdown();
			await startProjectContainers(db, projectId);
			await removeSeededContainerProject(db, 'cap-check-a');
			await clearContainerCapacityForTest(db);
		});

		it('a project whose container is already running is never capacity-blocked', async () => {
			const manager = createJobManager();
			// The project's own running container fills the single slot — but a run
			// into it needs no NEW container, so it must pass.
			await setContainerCapacityForTest(db, 1);
			expect(await (manager as any).isContainerCapacityBlocked(projectId)).toBe(false);
			manager.shutdown();
			await clearContainerCapacityForTest(db);
		});

		it('pending lazy-starts hold a slot and let same-project dispatches piggyback', async () => {
			const manager = createJobManager();
			await setContainerCapacityForTest(db, 1);
			await stopProjectContainers(db, projectId);
			(manager as any).acquirePendingContainerStart(projectId);

			// The same project piggybacks on the in-flight start…
			expect(await (manager as any).isContainerCapacityBlocked(projectId)).toBe(false);
			// …while a different project is blocked by the slot it holds.
			expect(
				await (manager as any).isContainerCapacityBlocked('00000000-0000-0000-0000-0000000000aa'),
			).toBe(true);

			(manager as any).releasePendingContainerStart(projectId);
			expect(
				await (manager as any).isContainerCapacityBlocked('00000000-0000-0000-0000-0000000000aa'),
			).toBe(false);

			manager.shutdown();
			await startProjectContainers(db, projectId);
			await clearContainerCapacityForTest(db);
		});

		it('re-queues a wakeup when the container limit is reached', async () => {
			const manager = createJobManager();
			await setContainerCapacityForTest(db, 1);
			await stopProjectContainers(db, projectId);
			await seedRunningContainerProject(db, 'cap-filler-requeue');

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at, payload)
				 VALUES ($1, $2, 'mention', 'queued', now() - interval '30 seconds', $3::jsonb)
				 RETURNING id`,
				[agentId, teamId, JSON.stringify({ task_id: taskId })],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).processWakeups();

			const status = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(status.rows[0].status).toBe(WakeupStatus.Queued);

			manager.shutdown();
			await startProjectContainers(db, projectId);
			await removeSeededContainerProject(db, 'cap-filler-requeue');
			await clearContainerCapacityForTest(db);
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		});

		it('the per-agent lock is gone: agent busy in project A does not block a wakeup for project B', async () => {
			const manager = createJobManager();

			// Project B lives in a SECOND team (a team owns exactly one project), so
			// it is genuinely distinct from project A. We never dispatch on it — we just
			// need a real, separate project id whose capacity we can check independently.
			const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
			const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;
			const teamBRes = await createTestTeam(db, {
				name: `Parallel Team ${Date.now()}`,
				template_id: typeId,
			});
			const teamBId = (await teamBRes.json()).data.id;
			const projectBRes = await createTestProject(db, teamBId, {
				name: `Parallel Project ${Date.now()}`,
				description: 'sibling project',
			});
			const projectBData = (await projectBRes.json()).data;
			const projectBId = projectBData.id;
			const projectBSlug = projectBData.slug;
			const agentBRes = await app.request(`/api/projects/${projectBSlug}/agents`, {
				headers: authHeader(token),
			});
			const agentBId = (await agentBRes.json()).data[0].id;
			const taskBRes = await app.request(`/api/projects/${projectBSlug}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					project_id: projectBId,
					title: 'Task in sibling project',
					assignee_id: agentBId,
				}),
			});
			const taskBId = (await taskBRes.json()).data.id;

			// Pretend the agent is mid-run in project A by pre-populating the
			// in-memory project refcount. This is what activateAgent does
			// synchronously before launchTask; using it directly here avoids spinning
			// up a real runAgent that would then race with cleanup.
			(manager as any).acquireProjectRun(projectId);
			(manager as any).runningTasks.set(`${agentId}:${projectId}`, {
				key: `${agentId}:${projectId}`,
				abortController: new AbortController(),
				promise: Promise.resolve(),
				startedAt: Date.now(),
				timeoutId: setTimeout(() => {}, 0),
			});

			// The legacy per-agent check would have skipped this wakeup. The
			// container-capacity check doesn't consider per-agent business at all:
			// with a free container slot, project B is not blocked by the agent's
			// activity in project A.
			expect(manager.isMemberRunning(agentId)).toBe(true);
			// "With a free container slot" is the premise, so derive the cap from what
			// is actually running rather than a literal: by this point in the file the
			// pool legitimately holds containers from earlier tests, and a hardcoded 2
			// would be asserting the cap, not the per-agent question under test.
			const { getActiveContainers } = await import('../src/services/run-concurrency');
			const active = await getActiveContainers(db, createStubDocker());
			await setContainerCapacityForTest(db, Math.ceil(active.usedMemoryGb / 2) + 1);
			expect(await (manager as any).isContainerCapacityBlocked(projectBId)).toBe(false);
			await clearContainerCapacityForTest(db);

			manager.shutdown();
			// Project B lives in its own team, so it cannot interfere with project A's
			// tests; the whole context is torn down in afterAll. Leave its rows in place
			// rather than untangle the team/agent/planning-task FK chain.
			void taskBId;
		});
	});

	describe('sweepStaleDispatches', () => {
		it('reaps a dispatch whose run is terminal but whose completion never settled', async () => {
			await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
			const manager = createJobManager();
			const key = `${agentId}:${projectId}`;

			// Simulate the wedge: the dispatched closure never settles on its own
			// (it resolves only when the sweep aborts it), while its run row has
			// long since gone terminal.
			(manager as any).activeTaskRuns.add(taskId);
			(manager as any).acquireProjectRun(projectId);
			const launched = manager.launchTask(
				key,
				(signal) =>
					new Promise((resolve) => {
						signal.addEventListener('abort', () => resolve(null));
					}),
				60 * 60 * 1000,
				{ memberId: agentId, taskId, projectId },
			);
			expect(launched).toBe(true);
			await db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at, exit_code)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '10 minutes', now() - interval '8 minutes', 0)`,
				[teamId, agentId, taskId, HeartbeatRunStatus.Succeeded],
			);
			(manager as any).runningTasks.get(key).startedAt = Date.now() - 10 * 60 * 1000;

			await (manager as any).sweepStaleDispatches();

			expect(manager.isTaskRunning(key)).toBe(false);
			expect((manager as any).activeTaskRuns.has(taskId)).toBe(false);
			expect((manager as any).activeProjectRuns.has(projectId)).toBe(false);

			// The wedged closure settling afterwards must not double-release the
			// project refcount a fresh dispatch now holds.
			await waitForBackground();
			(manager as any).activeTaskRuns.add(taskId);
			(manager as any).acquireProjectRun(projectId);
			expect(
				manager.launchTask(key, async () => null, 1000, {
					memberId: agentId,
					taskId,
					projectId,
				}),
			).toBe(true);
			expect((manager as any).activeProjectRuns.get(projectId)).toBe(1);
			await waitForBackground();

			manager.shutdown();
			await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
		});

		it('leaves a dispatch with a live run untouched', async () => {
			await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
			const manager = createJobManager();
			const key = `${agentId}:${projectId}`;

			(manager as any).activeTaskRuns.add(taskId);
			(manager as any).acquireProjectRun(projectId);
			let settle: (() => void) | undefined;
			manager.launchTask(
				key,
				() =>
					new Promise<void>((resolve) => {
						settle = resolve;
					}),
				60 * 60 * 1000,
				{ memberId: agentId, taskId, projectId },
			);
			await db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '10 minutes')`,
				[teamId, agentId, taskId, HeartbeatRunStatus.Running],
			);
			(manager as any).runningTasks.get(key).startedAt = Date.now() - 10 * 60 * 1000;

			await (manager as any).sweepStaleDispatches();

			expect(manager.isTaskRunning(key)).toBe(true);
			expect((manager as any).activeTaskRuns.has(taskId)).toBe(true);

			settle?.();
			await waitForBackground();
			manager.shutdown();
			await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
		});
	});

	describe('completion bookkeeping when runAgent throws', () => {
		it('releases the lock, idles the agent, and fails the wakeup', async () => {
			await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE member_id = $1 AND released_at IS NULL',
				[agentId],
			);

			// A log broker whose begin() throws makes runAgent throw outside its
			// own try/catch — the exact shape of a completion path that never
			// reaches onAgentComplete on its own.
			// The dispatch path requires a running container on the project; the
			// stub docker reports any container id as running.
			await db.query(
				`UPDATE projects SET container_id = 'stub-contain', container_status = 'running' WHERE id = $1`,
				[projectId],
			);
			let threw = false;
			const throwingLogs = new LogStreamBroker();
			throwingLogs.begin = () => {
				threw = true;
				throw new Error('synthetic stream failure');
			};
			const manager = createJobManager({ logs: throwingLogs });

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, created_at)
				 VALUES ($1, $2, 'assignment', 'queued', $3::jsonb, now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, teamId, JSON.stringify({ task_id: taskId, reason: 'unblocked' })],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).processWakeups();
			await waitForBackground();

			expect(threw).toBe(true);
			const wakeup = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(wakeup.rows[0].status).toBe(WakeupStatus.Failed);

			const locks = await db.query<{ id: string }>(
				'SELECT id FROM execution_locks WHERE member_id = $1 AND released_at IS NULL',
				[agentId],
			);
			expect(locks.rows).toHaveLength(0);

			const agent = await db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[agentId],
			);
			expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);

			expect(manager.isTaskRunning(`${agentId}:${projectId}`)).toBe(false);
			expect((manager as any).activeTaskRuns.has(taskId)).toBe(false);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
			await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
		});
	});
});
