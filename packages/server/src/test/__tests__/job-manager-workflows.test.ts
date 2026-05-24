import type { PGlite } from '@electric-sql/pglite';
import { AgentRuntimeStatus, HeartbeatRunStatus, TaskStatus, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { ContainerLogStreamer } from '../../services/container-logs';
import type { DockerClient } from '../../services/docker';
import { JobManager, type JobManagerDeps } from '../../services/job-manager';
import { LogStreamBroker } from '../../services/log-stream-broker';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, createTestProject } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let taskId: string;
let agentId: string;

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

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Workflow Test Co', template_id: typeId }),
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Workflow Test Project',
		description: 'Test project.',
	});
	projectId = (await projectRes.json()).data.id;

	const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const taskRes = await app.request(`/api/teams/${teamId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Workflow Test Task',
			description: 'Test task for workflow testing',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;

	// These tests focus on wakeup/lock lifecycle, not the designated-repo gate.
	// Seed a designated repo on the project so the gate short-circuit is bypassed.
	const repoRes = await db.query<{ id: string }>(
		`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
		 VALUES ($1, 'test', 'test-org/test-repo', 'github'::repo_host_type)
		 RETURNING id`,
		[projectId],
	);
	await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
		repoRes.rows[0].id,
		projectId,
	]);
});

afterAll(async () => {
	await safeClose(db);
});

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

		it('marks wakeup as completed when agent has no assigned tasks', async () => {
			const manager = createJobManager();

			// Ensure agent has no open tasks assigned to it
			await db.query(
				"UPDATE tasks SET assignee_id = NULL WHERE assignee_id = $1 AND status NOT IN ('done', 'closed', 'cancelled')",
				[agentId],
			);

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

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		});

		it('marks wakeup as failed when project has no container', async () => {
			const manager = createJobManager();

			// Assign the task to the agent (project has no container_id yet)
			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);

			// Ensure project has no container_id
			await db.query('UPDATE projects SET container_id = NULL WHERE id = $1', [projectId]);

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
			expect(result.rows[0].status).toBe(WakeupStatus.Failed);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
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

			const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
				headers: authHeader(token),
			});
			const agents = (await agentsRes.json()).data;
			const secondAgentId = agents.find((a: { id: string }) => a.id !== agentId).id;

			const firstWakeup = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at, payload)
				 VALUES ($1, $2, 'mention', 'claimed', now() - interval '30 seconds', $3::jsonb)
				 RETURNING id`,
				[agentId, teamId, JSON.stringify({ task_id: taskId })],
			);
			await (manager as any).activateAgent(agentId, teamId, firstWakeup.rows[0].id, {
				task_id: taskId,
			});

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
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = ANY($1)', [
				[firstWakeup.rows[0].id, secondWakeup.rows[0].id],
			]);
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

			it('posts a system comment and automation wakeup on failed status', async () => {
				await clearRunsAndComments();
				const runId = await seedRun(HeartbeatRunStatus.Failed, 'The operation timed out.');

				const manager = createJobManager();
				await (manager as any).onAgentComplete(
					agentId,
					'researcher',
					taskId,
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
					 WHERE member_id = $1 AND source = 'automation'
					 ORDER BY created_at DESC LIMIT 1`,
					[agentId],
				);
				expect(wakeups.rows.length).toBe(1);
				expect(wakeups.rows[0].payload).toMatchObject({
					task_id: taskId,
					run_id: runId,
					reason: 'run_failed',
				});

				manager.shutdown();
				await clearRunsAndComments();
			});

			it('posts the ping on timed_out status', async () => {
				await clearRunsAndComments();
				const runId = await seedRun(HeartbeatRunStatus.TimedOut, 'Heartbeat lapsed');

				const manager = createJobManager();
				await (manager as any).onAgentComplete(
					agentId,
					'researcher',
					taskId,
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
				   AND status NOT IN ('done', 'closed', 'cancelled')`,
				[agentId, taskId],
			);
			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);

			await (manager as any).onAgentComplete(
				agentId,
				'test-agent',
				taskId,
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
	});

	describe('coach auto-close', () => {
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

		it('closes a Done task after a successful coach run with task_done trigger', async () => {
			const manager = createJobManager();
			await setTaskDone();

			await (manager as any).onAgentComplete(
				agentId,
				'coach',
				taskId,
				teamId,
				undefined,
				{ trigger: 'task_done', task_id: taskId },
				{ success: true, exitCode: 0, stdout: '', stderr: '' },
			);

			expect(await readTaskStatus()).toBe(TaskStatus.Closed);
			manager.shutdown();
		});

		it('does not close when the coach run failed', async () => {
			const manager = createJobManager();
			await setTaskDone();

			await (manager as any).onAgentComplete(
				agentId,
				'coach',
				taskId,
				teamId,
				undefined,
				{ trigger: 'task_done', task_id: taskId },
				{ success: false, exitCode: 1, stdout: '', stderr: 'failed' },
			);

			expect(await readTaskStatus()).toBe(TaskStatus.Done);
			manager.shutdown();
		});

		it('does not close when a non-coach agent completes on a Done task', async () => {
			const manager = createJobManager();
			await setTaskDone();

			await (manager as any).onAgentComplete(
				agentId,
				'engineer',
				taskId,
				teamId,
				undefined,
				{ trigger: 'task_done', task_id: taskId },
				{ success: true, exitCode: 0, stdout: '', stderr: '' },
			);

			expect(await readTaskStatus()).toBe(TaskStatus.Done);
			manager.shutdown();
		});

		it('does not close when the task is no longer in Done', async () => {
			const manager = createJobManager();
			await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
				TaskStatus.Cancelled,
				taskId,
			]);

			await (manager as any).onAgentComplete(
				agentId,
				'coach',
				taskId,
				teamId,
				undefined,
				{ trigger: 'task_done', task_id: taskId },
				{ success: true, exitCode: 0, stdout: '', stderr: '' },
			);

			expect(await readTaskStatus()).toBe(TaskStatus.Cancelled);
			manager.shutdown();
		});

		it('does not close when wakeup payload trigger is not task_done', async () => {
			const manager = createJobManager();
			await setTaskDone();

			await (manager as any).onAgentComplete(
				agentId,
				'coach',
				taskId,
				teamId,
				undefined,
				{ trigger: 'mention', task_id: taskId },
				{ success: true, exitCode: 0, stdout: '', stderr: '' },
			);

			expect(await readTaskStatus()).toBe(TaskStatus.Done);
			manager.shutdown();
		});

		it('does not close when an open sub-task still blocks the parent', async () => {
			const manager = createJobManager();
			await setTaskDone();

			const childResult = await db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, assignee_id, parent_task_id, number, identifier,
				                     title, description, status, priority)
				 VALUES ($1, $2, $3, $4, 9999, 'TST-9999', 'Open child', '', 'in_progress'::task_status, 'medium'::task_priority)
				 RETURNING id`,
				[teamId, projectId, agentId, taskId],
			);
			const childId = childResult.rows[0].id;

			await (manager as any).onAgentComplete(
				agentId,
				'coach',
				taskId,
				teamId,
				undefined,
				{ trigger: 'task_done', task_id: taskId },
				{ success: true, exitCode: 0, stdout: '', stderr: '' },
			);

			expect(await readTaskStatus()).toBe(TaskStatus.Done);
			manager.shutdown();

			await db.query('DELETE FROM tasks WHERE id = $1', [childId]);
		});
	});

	describe('processScheduledHeartbeats', () => {
		it('does not process agents with paused runtime status', async () => {
			const manager = createJobManager();

			// Pause the agent
			await db.query(
				"UPDATE member_agents SET runtime_status = 'paused', last_heartbeat_at = now() - interval '2 hours' WHERE id = $1",
				[agentId],
			);

			await (manager as any).processScheduledHeartbeats();

			// Task should NOT be launched for a paused agent
			expect(manager.isMemberRunning(agentId)).toBe(false);

			// Restore runtime status
			await db.query("UPDATE member_agents SET runtime_status = 'idle' WHERE id = $1", [agentId]);

			manager.shutdown();
		});

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
				   AND ma.runtime_status != 'paused'
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

			const dueCheck = await db.query<{ id: string }>(
				`SELECT ma.id
				 FROM member_agents ma
				 JOIN members m ON m.id = ma.id
				 WHERE ma.admin_status = 'enabled'
				   AND ma.runtime_status != 'paused'
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

			// Simulate a running task already (project-scoped key matches activateAgent)
			manager.launchTask(
				`${agentId}:${projectId}`,
				async () => {
					await new Promise((r) => setTimeout(r, 5000));
				},
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
			const otherAgentRes = await app.request(`/api/teams/${teamId}/agents`, {
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

	describe('per-project serialisation and cross-project parallelism', () => {
		it('isProjectBusy returns true while another task in the same project is running', async () => {
			const manager = createJobManager();

			const otherTaskRes = await app.request(`/api/teams/${teamId}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					project_id: projectId,
					title: 'Sibling task in same project',
					assignee_id: agentId,
				}),
			});
			const otherTaskId = (await otherTaskRes.json()).data.id;

			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
				[agentId, teamId, otherTaskId, HeartbeatRunStatus.Running],
			);

			const busy = await (manager as any).isProjectBusy(projectId);
			expect(busy).toBe(true);

			await db.query(
				"UPDATE heartbeat_runs SET status = 'succeeded', finished_at = now() WHERE task_id = $1",
				[otherTaskId],
			);
			const busyAfter = await (manager as any).isProjectBusy(projectId);
			expect(busyAfter).toBe(false);

			manager.shutdown();
			await db.query('DELETE FROM heartbeat_runs WHERE task_id = $1', [otherTaskId]);
			await db.query('DELETE FROM tasks WHERE id = $1', [otherTaskId]);
		});

		it('re-queues a wakeup when its project already has a different active run', async () => {
			const manager = createJobManager();

			// Stand up a sibling project + task for this team so an unrelated active
			// run in project A blocks a wakeup targeting another task in project A.
			const sibTaskRes = await app.request(`/api/teams/${teamId}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					project_id: projectId,
					title: 'Second task in project A',
					assignee_id: agentId,
				}),
			});
			const sibTaskId = (await sibTaskRes.json()).data.id;

			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
				[agentId, teamId, taskId, HeartbeatRunStatus.Running],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, created_at, payload)
				 VALUES ($1, $2, 'mention', 'queued', now() - interval '30 seconds', $3::jsonb)
				 RETURNING id`,
				[agentId, teamId, JSON.stringify({ task_id: sibTaskId })],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).processWakeups();

			const status = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(status.rows[0].status).toBe(WakeupStatus.Queued);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
			await db.query('DELETE FROM heartbeat_runs WHERE task_id = $1', [taskId]);
			await db.query('DELETE FROM tasks WHERE id = $1', [sibTaskId]);
		});

		it('the per-agent lock is gone: agent busy in project A does not block a wakeup for project B', async () => {
			const manager = createJobManager();

			// Project B (sibling) with a task assigned to the same agent. We never
			// dispatch on this one — we just need the row to exist so resolveProjectForTask
			// returns a real project id that is distinct from project A.
			const projectBRes = await createTestProject(db, teamId, {
				name: `Parallel Project ${Date.now()}`,
				description: 'sibling project',
			});
			const projectBId = (await projectBRes.json()).data.id;
			const taskBRes = await app.request(`/api/teams/${teamId}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					project_id: projectBId,
					title: 'Task in sibling project',
					assignee_id: agentId,
				}),
			});
			const taskBId = (await taskBRes.json()).data.id;

			// Pretend the agent is mid-run in project A by pre-populating the
			// in-memory project lock. This is what activateAgent does synchronously
			// before launchTask; using it directly here avoids spinning up a real
			// runAgent that would then race with cleanup.
			(manager as any).activeProjectRuns.add(projectId);
			(manager as any).runningTasks.set(`${agentId}:${projectId}`, {
				key: `${agentId}:${projectId}`,
				abortController: new AbortController(),
				promise: Promise.resolve(),
				startedAt: Date.now(),
				timeoutId: setTimeout(() => {}, 0),
			});

			// The legacy per-agent check would have skipped this wakeup. The
			// per-project check should not: project B has no active run.
			expect(manager.isMemberRunning(agentId)).toBe(true);
			expect(await (manager as any).isProjectBusy(projectId)).toBe(true);
			expect(await (manager as any).isProjectBusy(projectBId)).toBe(false);

			manager.shutdown();
			await db.query('DELETE FROM tasks WHERE id = $1', [taskBId]);
			await db.query('DELETE FROM projects WHERE id = $1', [projectBId]);
		});
	});
});
