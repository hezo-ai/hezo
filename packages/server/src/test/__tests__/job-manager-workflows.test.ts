import type { PGlite } from '@electric-sql/pglite';
import { AgentAdminStatus, AgentRuntimeStatus, IssueStatus, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import type { DockerClient } from '../../services/docker';
import { JobManager, type JobManagerDeps } from '../../services/job-manager';
import { LogStreamBroker } from '../../services/log-stream-broker';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let projectId: string;
let issueId: string;
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
		...overrides,
	});
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Workflow Test Co', template_id: typeId, issue_prefix: 'WF' }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Workflow Test Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Workflow Test Issue',
			description: 'Test issue for workflow testing',
			assignee_id: agentId,
		}),
	});
	issueId = (await issueRes.json()).data.id;
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
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'queued', now())`,
				[agentId, companyId],
			);

			await (manager as any).processWakeups();

			// Should still be queued since it's too recent
			const result = await db.query<{ status: string }>(
				`SELECT status FROM agent_wakeup_requests
				 WHERE member_id = $1 AND company_id = $2
				   AND source = 'on_demand'
				 ORDER BY created_at DESC LIMIT 1`,
				[agentId, companyId],
			);
			expect(result.rows[0].status).toBe(WakeupStatus.Queued);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1 AND company_id = $2', [
				agentId,
				companyId,
			]);
		});

		it('claims old queued wakeups and advances their status', async () => {
			const manager = createJobManager();

			// Insert a wakeup created 30 seconds ago (past the coalescing window)
			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'queued', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, companyId],
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

			// Simulate a running task for this agent
			manager.launchTask(
				`agent:${agentId}`,
				async () => {
					await new Promise((r) => setTimeout(r, 5000));
				},
				10_000,
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'queued', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, companyId],
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
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, companyId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			// Use a non-existent member ID
			const fakeId = '00000000-0000-0000-0000-000000000001';
			await (manager as any).activateAgent(fakeId, companyId, wakeupId);

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
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, companyId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).activateAgent(agentId, companyId, wakeupId);

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

		it('marks wakeup as completed when agent has no assigned issues', async () => {
			const manager = createJobManager();

			// Ensure agent has no open issues assigned to it
			await db.query(
				"UPDATE issues SET assignee_id = NULL WHERE assignee_id = $1 AND status NOT IN ('done', 'closed', 'cancelled')",
				[agentId],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, companyId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).activateAgent(agentId, companyId, wakeupId);

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

			// Assign the issue to the agent (project has no container_id yet)
			await db.query('UPDATE issues SET assignee_id = $1 WHERE id = $2', [agentId, issueId]);

			// Ensure project has no container_id
			await db.query('UPDATE projects SET container_id = NULL WHERE id = $1', [projectId]);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, companyId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).activateAgent(agentId, companyId, wakeupId);

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

			// Assign the issue to the agent
			await db.query('UPDATE issues SET assignee_id = $1 WHERE id = $2', [agentId, issueId]);

			// Give the project a container
			await db.query(
				"UPDATE projects SET container_id = 'test-container-id', container_status = 'running' WHERE id = $1",
				[projectId],
			);

			// Release any existing execution lock for this pair
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE issue_id = $1 AND member_id = $2 AND released_at IS NULL',
				[issueId, agentId],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, companyId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).activateAgent(agentId, companyId, wakeupId);

			// An execution lock should have been created
			const lockResult = await db.query<{ issue_id: string; member_id: string }>(
				'SELECT issue_id, member_id FROM execution_locks WHERE issue_id = $1 AND member_id = $2',
				[issueId, agentId],
			);
			expect(lockResult.rows.length).toBeGreaterThan(0);
			expect(lockResult.rows[lockResult.rows.length - 1].issue_id).toBe(issueId);
			expect(lockResult.rows[lockResult.rows.length - 1].member_id).toBe(agentId);

			// A task should have been launched for the agent
			expect(manager.isTaskRunning(`agent:${agentId}`)).toBe(true);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE issue_id = $1 AND member_id = $2 AND released_at IS NULL',
				[issueId, agentId],
			);
		});

		it('allows a second agent to acquire an execution lock while another agent is running on the same issue', async () => {
			const manager = createJobManager();

			await db.query('UPDATE issues SET assignee_id = $1 WHERE id = $2', [agentId, issueId]);
			await db.query(
				"UPDATE projects SET container_id = 'test-container-id', container_status = 'running' WHERE id = $1",
				[projectId],
			);
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE issue_id = $1 AND released_at IS NULL',
				[issueId],
			);

			const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
				headers: authHeader(token),
			});
			const agents = (await agentsRes.json()).data;
			const secondAgentId = agents.find((a: { id: string }) => a.id !== agentId).id;

			const firstWakeup = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at, payload)
				 VALUES ($1, $2, 'mention', 'claimed', now() - interval '30 seconds', $3::jsonb)
				 RETURNING id`,
				[agentId, companyId, JSON.stringify({ issue_id: issueId })],
			);
			await (manager as any).activateAgent(agentId, companyId, firstWakeup.rows[0].id, {
				issue_id: issueId,
			});

			const secondWakeup = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at, payload)
				 VALUES ($1, $2, 'mention', 'claimed', now() - interval '30 seconds', $3::jsonb)
				 RETURNING id`,
				[secondAgentId, companyId, JSON.stringify({ issue_id: issueId })],
			);
			await (manager as any).activateAgent(secondAgentId, companyId, secondWakeup.rows[0].id, {
				issue_id: issueId,
			});

			const locks = await db.query<{ member_id: string }>(
				`SELECT member_id FROM execution_locks
				 WHERE issue_id = $1 AND released_at IS NULL
				 ORDER BY locked_at`,
				[issueId],
			);
			const holders = locks.rows.map((r) => r.member_id).sort();
			expect(holders).toEqual([agentId, secondAgentId].sort());

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = ANY($1)', [
				[firstWakeup.rows[0].id, secondWakeup.rows[0].id],
			]);
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE issue_id = $1 AND released_at IS NULL',
				[issueId],
			);
		});

		it('defers the wakeup when the same agent already holds a lock on the issue', async () => {
			const manager = createJobManager();

			await db.query('UPDATE issues SET assignee_id = $1 WHERE id = $2', [agentId, issueId]);
			await db.query(
				"UPDATE projects SET container_id = 'test-container-id', container_status = 'running' WHERE id = $1",
				[projectId],
			);
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE issue_id = $1 AND released_at IS NULL',
				[issueId],
			);

			await db.query(
				"INSERT INTO execution_locks (issue_id, member_id, lock_type) VALUES ($1, $2, 'read')",
				[issueId, agentId],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at, payload)
				 VALUES ($1, $2, 'mention', 'claimed', now() - interval '30 seconds', $3::jsonb)
				 RETURNING id`,
				[agentId, companyId, JSON.stringify({ issue_id: issueId })],
			);
			await (manager as any).activateAgent(agentId, companyId, wakeupRes.rows[0].id, {
				issue_id: issueId,
			});

			const status = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupRes.rows[0].id],
			);
			expect(status.rows[0].status).toBe(WakeupStatus.Deferred);

			const locks = await db.query<{ id: string }>(
				'SELECT id FROM execution_locks WHERE issue_id = $1 AND member_id = $2 AND released_at IS NULL',
				[issueId, agentId],
			);
			expect(locks.rows.length).toBe(1);

			manager.shutdown();
			await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeupRes.rows[0].id]);
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE issue_id = $1 AND released_at IS NULL',
				[issueId],
			);
		});

		it('with issue_done trigger wakeup marks completed when trigger issue is not found', async () => {
			const manager = createJobManager();

			// Unassign the issue so the agent has no open assigned issues
			await db.query('UPDATE issues SET assignee_id = NULL WHERE id = $1', [issueId]);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at, payload)
				 VALUES ($1, $2, 'automation', 'claimed', now() - interval '30 seconds',
				         '{"trigger": "issue_done", "issue_id": "00000000-0000-0000-0000-000000000099"}'::jsonb)
				 RETURNING id`,
				[agentId, companyId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).activateAgent(agentId, companyId, wakeupId, {
				trigger: 'issue_done',
				issue_id: '00000000-0000-0000-0000-000000000099',
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
				`INSERT INTO execution_locks (issue_id, member_id)
				 VALUES ($1, $2)
				 ON CONFLICT DO NOTHING`,
				[issueId, agentId],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, companyId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).onAgentComplete(agentId, issueId, companyId, wakeupId, {
				success: true,
				exitCode: 0,
				stdout: '',
				stderr: '',
			});

			// Lock should be released
			const lockResult = await db.query<{ released_at: string | null }>(
				'SELECT released_at FROM execution_locks WHERE issue_id = $1 AND member_id = $2 ORDER BY locked_at DESC LIMIT 1',
				[issueId, agentId],
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
				`INSERT INTO execution_locks (issue_id, member_id)
				 VALUES ($1, $2)
				 ON CONFLICT DO NOTHING`,
				[issueId, agentId],
			);

			const wakeupRes = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at)
				 VALUES ($1, $2, 'on_demand', 'claimed', now() - interval '30 seconds')
				 RETURNING id`,
				[agentId, companyId],
			);
			const wakeupId = wakeupRes.rows[0].id;

			await (manager as any).onAgentComplete(agentId, issueId, companyId, wakeupId, {
				success: false,
				exitCode: 1,
				stdout: '',
				stderr: 'something went wrong',
			});

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
				`INSERT INTO execution_locks (issue_id, member_id)
				 VALUES ($1, $2)
				 ON CONFLICT DO NOTHING`,
				[issueId, agentId],
			);

			// Call without a wakeupId (heartbeat-triggered run scenario)
			await (manager as any).onAgentComplete(agentId, issueId, companyId, undefined, {
				success: true,
				exitCode: 0,
				stdout: '',
				stderr: '',
			});

			// Lock should still be released
			const lockResult = await db.query<{ released_at: string | null }>(
				'SELECT released_at FROM execution_locks WHERE issue_id = $1 AND member_id = $2 ORDER BY locked_at DESC LIMIT 1',
				[issueId, agentId],
			);
			expect(lockResult.rows[0].released_at).not.toBeNull();

			manager.shutdown();
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
			expect(manager.isTaskRunning(`agent:${agentId}`)).toBe(false);

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
			const dueAgents = await db.query<{ id: string; company_id: string }>(
				`SELECT ma.id, m.company_id, ma.heartbeat_interval_min
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

		it('skips agents with null last_heartbeat_at that already have running tasks', async () => {
			const manager = createJobManager();

			// Simulate a running task already
			manager.launchTask(
				`agent:${agentId}`,
				async () => {
					await new Promise((r) => setTimeout(r, 5000));
				},
				10_000,
			);

			// Agent has never heartbeated, so it should normally be picked up
			await db.query('UPDATE member_agents SET last_heartbeat_at = NULL WHERE id = $1', [agentId]);

			// Count launches before
			const taskWasRunning = manager.isTaskRunning(`agent:${agentId}`);
			expect(taskWasRunning).toBe(true);

			await (manager as any).processScheduledHeartbeats();

			// Task still running (was not restarted — the existing task was skipped)
			expect(manager.isTaskRunning(`agent:${agentId}`)).toBe(true);

			manager.shutdown();
		});
	});
});
